import * as fs from 'node:fs';
import * as path from 'node:path';
import SemanticReleaseError from '@semantic-release/error';
import * as yaml from 'yaml';
import { messageOf } from './utils/error.js';
import { isRecord } from './utils/object.js';

/**
 * Schema for Chart.yaml used by tests and serialization. Additional
 * keys are permitted and preserved. Only a minimal subset is typed
 * explicitly to avoid needless churn when Helm adds new fields.
 */
export interface ChartYaml {
  apiVersion?: string;
  name: string;
  version?: string;
  [key: string]: unknown;
}

/**
 * Parse Chart.yaml text, turning a YAML syntax problem into a coded error that
 * names the file.
 *
 * @param text Chart.yaml content.
 * @param file Path of the file, for the message.
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
 * Minimal chart metadata required by the plugin and tests. The full
 * parsed Chart.yaml is retained as a raw map for round-tripping and
 * passthrough into index entries.
 */
export class HelmChart {
  private readonly data: ChartYaml;

  /**
   * Load Chart.yaml from a chart directory and normalize well-known
   * fields. Unknown keys are preserved verbatim for later writes.
   *
   * @param chartDir Path to the directory that contains Chart.yaml.
   */
  static from(chartDir: string): HelmChart {
    const chartYamlPath = path.join(chartDir, 'Chart.yaml');
    const rawText = fs.readFileSync(chartYamlPath, 'utf8');
    const parsed = parseChartYaml(rawText, chartYamlPath);
    const record = isRecord(parsed) ? parsed : {};

    const normalized: ChartYaml = {
      ...record,
      name:
        typeof record.name === 'string'
          ? record.name
          : String(record.name ?? ''),
      ...(record.version !== undefined && { version: String(record.version) }),
      ...(record.apiVersion !== undefined && {
        apiVersion: String(record.apiVersion),
      }),
    };

    return new HelmChart(normalized);
  }

  /**
   * Create a chart from a parsed Chart.yaml object. Callers should
   * prefer the factory unless constructing for tests.
   *
   * @param data Parsed Chart.yaml as a mutable object.
   */
  constructor(data: ChartYaml) {
    this.data = { ...data };
  }

  /**
   * Return the chart name as a string. The value is sourced from
   * Chart.yaml and normalized during construction.
   */
  name(): string {
    return String(this.data.name ?? '');
  }

  /**
   * Return the chart version as a string, or undefined when Chart.
   * yaml did not define one.
   */
  version(): string | undefined {
    return this.data.version === undefined
      ? undefined
      : String(this.data.version);
  }

  /**
   * Return the chart API version as a string, or undefined when the
   * field is not present.
   */
  apiVersion(): string | undefined {
    return this.data.apiVersion === undefined
      ? undefined
      : String(this.data.apiVersion);
  }

  /**
   * Produce a new HelmChart with the version field replaced by the
   * provided value. The instance is immutable; the original object
   * remains unchanged.
   *
   * @param version New semantic version to set on the chart.
   */
  withVersion(version: string): HelmChart {
    const next: ChartYaml = { ...this.data, version };
    return new HelmChart(next);
  }

  /**
   * Serialize the current chart to YAML and write the result to the
   * given file path. All unknown fields are preserved verbatim.
   *
   * @param filePath Destination path for the Chart.yaml file.
   */
  saveTo(filePath: string): void {
    const text = yaml.stringify(this.data);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text, 'utf8');
  }

  /**
   * Return a shallow copy of the raw parsed Chart.yaml object for
   * callers that need to pass through metadata into other files.
   */
  raw(): Record<string, unknown> {
    return { ...this.data };
  }

  /**
   * Serialize the chart to a YAML string suitable for inspection or
   * custom persistence in tests and utilities.
   */
  toYAML(): string {
    return yaml.stringify(this.data);
  }
}

/**
 * Escape a string for use in a regular expression.
 *
 * @param text Literal text.
 * @returns A pattern matching the text exactly.
 */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render a version as a YAML scalar in the style of the one it replaces.
 *
 * @param version The new version.
 * @param style The style of the existing node.
 * @returns Source text for the scalar.
 */
function versionScalar(version: string, style: string | undefined): string {
  if (style === 'QUOTE_DOUBLE') {
    return JSON.stringify(version);
  }
  if (style === 'QUOTE_SINGLE') {
    return `'${version.replace(/'/g, "''")}'`;
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
 *
 * @param rawYaml Raw Chart.yaml content.
 * @param version Version string to set.
 * @param file Name of the file, used in error messages.
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
    new RegExp(`\\*${escapeForRegExp(existing.anchor)}(?![\\w-])`).test(rawYaml)
  ) {
    throw refuse(
      `The version in ${file} is shared through a YAML anchor.`,
      'Rewriting it would also change every alias of it (for example appVersion); give version its own value.',
    );
  }
  const [start, end] = existing.range;
  return `${rawYaml.slice(0, start)}${versionScalar(version, existing.type)}${rawYaml.slice(end)}`;
}
