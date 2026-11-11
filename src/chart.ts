/**
 * @file Reads, updates and templates a Helm chart's Chart.yaml and its README values table.
 */
import fs from 'node:fs';
import path from 'node:path';
import SemanticReleaseError from '@semantic-release/error';
import yaml from 'yaml';
import type { CommandContext } from './command-runner.js';
import { ChartPackage } from './chart-package.js';
import type { DockerImage } from './docker.js';
import { normalizeReadmeValuesTableFile } from './helm-docs.js';
import { messageOf } from './utils/error.js';
import { isRecord } from './utils/object.js';

/**
 * Schema for Chart.yaml. Additional keys are permitted and preserved. Only a
 * minimal subset is typed explicitly to avoid needless churn when Helm adds
 * new fields.
 */
export interface ChartYaml {
  apiVersion?: string;
  name: string;
  version?: string;
  [key: string]: unknown;
}

/**
 * Settings of a chart handle.
 */
export interface ChartOptions extends CommandContext {
  /** Chart directory, relative to `cwd`. */
  readonly directory: string;
  /** The image with the Helm CLI. */
  readonly helm: DockerImage;
  /** The image with helm-docs. */
  readonly docs: DockerImage;
}

/**
 * Parse Chart.yaml text, turning a YAML syntax problem into a coded error that
 * names the file.
 * @param text - Chart.yaml content.
 * @param file - Path of the file, for the message.
 * @returns The parsed value, whatever its shape.
 * @throws SemanticReleaseError (`EINVALIDCHARTYAML`) when it does not parse.
 */
function parseChartYaml(text: string, file: string): unknown {
  try {
    return yaml.parse(text);
  } catch (error) {
    throw new SemanticReleaseError(
      `${file} is not valid YAML.`,
      'EINVALIDCHARTYAML',
      `${file}: ${messageOf(error)}`,
    );
  }
}

/**
 * Read Chart.yaml text into its normalised fields: the name, version and
 * apiVersion as strings, every other key kept as it is.
 * @param text - Chart.yaml content.
 * @param file - Path of the file, for messages.
 * @returns The typed Chart.yaml fields read from the document.
 */
function readFields(text: string, file: string): ChartYaml {
  const parsed = parseChartYaml(text, file);
  const record = isRecord(parsed) ? parsed : {};
  return {
    ...record,
    name:
      typeof record.name === 'string' ? record.name : String(record.name ?? ''),
    ...(record.version !== undefined && { version: String(record.version) }),
    ...(record.apiVersion !== undefined && {
      apiVersion: String(record.apiVersion),
    }),
  };
}

/**
 * Flatten nested objects into dotted keys with string values. Arrays and
 * other non-object values are not descended into; they are stringified.
 * @param record - The object to flatten.
 * @param prefix - Dotted prefix for the keys, empty at the top level.
 * @returns A flat map such as `{ 'image.tag': 'v1' }`.
 */
function flattenRecord(
  record: Readonly<Record<string, unknown>>,
  prefix = '',
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, value]) => {
      const dotted = prefix.length > 0 ? `${prefix}.${key}` : key;
      if (isRecord(value)) {
        return Object.entries(flattenRecord(value, dotted));
      }
      return [[dotted, String(value)]];
    }),
  );
}

/**
 * Turn template values into `helm template` arguments: one `--set` and one
 * `key=value` per flattened leaf.
 * @param values - The configured template values, if any.
 * @returns Arguments to append to the command, empty when there are none.
 */
export function templateSetArgs(
  values: Readonly<Record<string, unknown>> | undefined,
): string[] {
  return Object.entries(flattenRecord(values ?? {})).flatMap(([key, value]) => [
    '--set',
    `${key}=${value}`,
  ]);
}

/**
 * Escape a string for use in a regular expression.
 * @param text - Literal text.
 * @returns A pattern matching the text exactly.
 */
function escapeForRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * The text to put where a blank value was (`version:`, `version: # note`,
 * `{version:}`): the scalar, with a space before it when the colon touches it
 * and a space after it when a comment follows.
 * @param text - The whole Chart.yaml text.
 * @param at - Where the blank value is.
 * @param scalar - The version as a YAML scalar.
 * @returns The text to insert.
 */
function blankValue(text: string, at: number, scalar: string): string {
  const before = /\s/.test(text.charAt(at - 1)) ? '' : ' ';
  const after = text.charAt(at) === '#' ? ' ' : '';
  return `${before}${scalar}${after}`;
}

/**
 * Render a version as a YAML scalar in the style of the one it replaces.
 * @param version - The new version.
 * @param style - The style of the existing node.
 * @returns Source text for the scalar.
 */
function versionScalar(version: string, style: string | undefined): string {
  if (style === 'QUOTE_DOUBLE') {
    return JSON.stringify(version);
  }
  if (style === 'QUOTE_SINGLE') {
    return `'${version.replaceAll("'", "''")}'`;
  }
  return yaml.stringify(version, { lineWidth: 0 }).trimEnd();
}

/**
 * Return a new Chart.yaml string with only the `version` value changed. The
 * text of the version node is replaced in place, so every other byte
 * (indentation, comments, quoting, line endings, number formats, blank lines)
 * stays as it was; a missing version is appended at the end. The file is
 * refused rather than rewritten when it is empty or not a mapping, when its
 * version is not a plain or quoted scalar, or when the version is shared
 * through a YAML anchor that something aliases (rewriting it would also change
 * the alias, for example appVersion).
 * @param rawYaml - Raw Chart.yaml content.
 * @param version - Version string to set.
 * @param file - Name of the file, used in error messages.
 * @returns Updated YAML string.
 * @throws SemanticReleaseError (`EINVALIDCHARTYAML`) for any of the cases
 *   above and for YAML that does not parse; the message names the file.
 */
export function setChartVersion(
  rawYaml: string,
  version: string,
  file = 'Chart.yaml',
): string {
  const refuse = (message: string, details: string): SemanticReleaseError =>
    new SemanticReleaseError(message, 'EINVALIDCHARTYAML', details);
  const doc = yaml.parseDocument(rawYaml);
  const [parseError] = doc.errors;
  if (parseError) {
    throw refuse(
      `${file} is not valid YAML.`,
      `${file}: ${parseError.message}`,
    );
  }
  if (!yaml.isMap(doc.contents)) {
    throw refuse(
      `${file} is not a YAML mapping.`,
      `${file} must be a mapping with at least a name and a version.`,
    );
  }
  const existing = doc.get('version', true);
  if (existing === undefined) {
    const eol = rawYaml.includes('\r\n') ? '\r\n' : '\n';
    if (doc.contents.flow) {
      doc.set('version', version);
      return doc.toString({ lineWidth: 0 });
    }
    const body = /\r?\n$/.test(rawYaml) ? rawYaml : `${rawYaml}${eol}`;
    return `${body}version: ${versionScalar(version, undefined)}${eol}`;
  }
  if (!yaml.isScalar(existing) || !existing.range) {
    throw refuse(
      `The version in ${file} is not a scalar.`,
      `${file}: version must be a plain or quoted string.`,
    );
  }
  if (existing.type === 'BLOCK_LITERAL' || existing.type === 'BLOCK_FOLDED') {
    throw refuse(
      `The version in ${file} is a block scalar.`,
      `${file}: version must be a plain or quoted string.`,
    );
  }
  if (
    existing.anchor &&
    new RegExp(String.raw`\*${escapeForRegExp(existing.anchor)}(?![\w-])`).test(
      rawYaml,
    )
  ) {
    throw refuse(
      `The version in ${file} is shared through a YAML anchor.`,
      'Rewriting it would also change every alias of it (for example appVersion); give version its own value.',
    );
  }
  const [start, end] = existing.range;
  const scalar = versionScalar(version, existing.type);
  if (start === end) {
    return `${rawYaml.slice(0, start)}${blankValue(rawYaml, start, scalar)}${rawYaml.slice(end)}`;
  }
  return `${rawYaml.slice(0, start)}${scalar}${rawYaml.slice(end)}`;
}

/**
 * A Helm chart on disk. It knows its own metadata, can change its version,
 * and works with Helm: lint, render, document and package. Methods that
 * produce something return it: a new chart, a manifest, a package.
 */
export class Chart {
  private readonly options: ChartOptions;

  private readonly text: string;

  private readonly fields: ChartYaml;

  /**
   * @param options - Directory, images, logger, base directory and runner.
   * @param text - The Chart.yaml text.
   * @param fields - The parsed, normalised fields of the text.
   */
  private constructor(options: ChartOptions, text: string, fields: ChartYaml) {
    this.options = options;
    this.text = text;
    this.fields = fields;
  }

  /**
   * Read the chart in `options.directory`.
   * @param options - Directory, images, logger, base directory and runner.
   * @returns The chart loaded from its Chart.yaml.
   * @throws SemanticReleaseError (`EINVALIDCHARTYAML`) when Chart.yaml does
   *   not parse.
   */
  static open(options: ChartOptions): Chart {
    const file = Chart.fileOf(options);
    const text = fs.readFileSync(file, 'utf8');
    return new Chart(options, text, readFields(text, file));
  }

  /**
   * Whether the directory holds a Chart.yaml.
   * @param options - Directory and base directory.
   * @returns True when the file exists.
   */
  static exists(options: Pick<ChartOptions, 'directory' | 'cwd'>): boolean {
    return fs.existsSync(Chart.fileOf(options));
  }

  /**
   * The full path of the chart's Chart.yaml.
   * @param options - Directory and base directory.
   * @returns The path.
   */
  private static fileOf(
    options: Pick<ChartOptions, 'directory' | 'cwd'>,
  ): string {
    return path.join(options.cwd, options.directory, 'Chart.yaml');
  }

  /**
   * The chart name.
   * @returns The name, or an empty string when Chart.yaml has none.
   */
  name(): string {
    return String(this.fields.name ?? '');
  }

  /**
   * The chart version.
   * @returns The version, or undefined when Chart.yaml has none.
   */
  version(): string | undefined {
    if (this.fields.version === undefined) {
      return undefined;
    }
    return String(this.fields.version);
  }

  /**
   * The chart API version.
   * @returns The API version, or undefined when Chart.yaml has none.
   */
  apiVersion(): string | undefined {
    if (this.fields.apiVersion === undefined) {
      return undefined;
    }
    return String(this.fields.apiVersion);
  }

  /**
   * A copy of every field of Chart.yaml, for passing metadata on.
   * @returns The fields.
   */
  metadata(): Record<string, unknown> {
    return { ...this.fields };
  }

  /**
   * The packages, from a list found on disk, that this chart produced:
   * those named `<name>-<version>.tgz`. Others are leftovers of earlier runs.
   * @param found - Packages found in the output directory.
   * @returns The packages of this chart, in the order given.
   */
  select(found: readonly ChartPackage[]): readonly ChartPackage[] {
    const fileName = `${this.name()}-${this.version() ?? ''}.tgz`;
    return found.filter((pkg) => pkg.fileName === fileName);
  }

  /**
   * The chart with a different version. Only the version value of the text
   * changes (see `setChartVersion`); this chart is left as it was and nothing
   * is written until `save`.
   * @param version - The new version.
   * @returns The updated chart.
   * @throws SemanticReleaseError (`EINVALIDCHARTYAML`) when the file cannot
   *   be edited safely.
   */
  withVersion(version: string): Chart {
    const file = Chart.fileOf(this.options);
    const text = setChartVersion(this.text, version, file);
    return new Chart(this.options, text, readFields(text, file));
  }

  /**
   * Write the chart's Chart.yaml.
   * @returns This chart.
   */
  save(): Chart {
    fs.writeFileSync(Chart.fileOf(this.options), this.text, 'utf8');
    return this;
  }

  /**
   * Lint the chart with Helm.
   * @throws The error from Helm when the chart does not lint.
   */
  async lint(): Promise<void> {
    await this.options.helm.run(['lint', this.options.directory]);
  }

  /**
   * Render the chart, with values set from a nested object, to check that it
   * templates.
   * @param values - Values to set, flattened to `--set key=value`.
   * @returns The rendered manifest.
   */
  async render(
    values: Readonly<Record<string, unknown>> | undefined,
  ): Promise<string> {
    return this.options.helm.run([
      'template',
      'sr-check',
      this.options.directory,
      ...templateSetArgs(values),
    ]);
  }

  /**
   * Regenerate the chart documentation with helm-docs. A failure is logged
   * and does not stop the release.
   * @param args - Extra arguments for helm-docs.
   * @returns This chart.
   */
  async document(args: readonly string[]): Promise<Chart> {
    const { logger, cwd, docs, directory } = this.options;
    try {
      const readmePath = path.join(cwd, directory, 'README.md');
      if (fs.existsSync(readmePath)) {
        const { changed } = normalizeReadmeValuesTableFile(readmePath);
        if (changed) {
          logger.log('helm-docs: normalized README valuesTable block(s)');
        } else {
          logger.log(
            'helm-docs: README normalization not needed (no markers found)',
          );
        }
      } else {
        logger.log('helm-docs: README.md not found; skipping normalization');
      }
      await docs.run([
        'helm-docs',
        `--chart-search-root=${directory}`,
        ...args,
      ]);
      logger.log('prepare: helm-docs succeeded');
    } catch {
      logger.log(
        'prepare: helm-docs failed or missing; skipping docs generation',
      );
    }
    return this;
  }

  /**
   * Package the chart.
   * @param destination - Output directory, relative to the repository root.
   * @returns The package that Helm wrote.
   */
  async package(destination: string): Promise<ChartPackage> {
    await this.options.helm.run([
      'package',
      this.options.directory,
      `--destination=${destination}`,
    ]);
    const fileName = `${this.name()}-${this.version() ?? ''}.tgz`;
    return ChartPackage.of(
      path.join(this.options.cwd, destination, fileName),
      this.name(),
      this.version() ?? '',
    );
  }
}
