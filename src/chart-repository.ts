import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import type { Chart } from './chart.js';
import type { ChartPackage } from './chart-package.js';
import SemanticReleaseError from '@semantic-release/error';
import { messageOf } from './utils/error.js';
import { isRecord } from './utils/object.js';

/**
 * Entry schema for a single chart version inside an index. The type
 * is intentionally permissive to remain forward compatible with new
 * Helm metadata. Tests rely on the version field being present.
 */
export interface ChartEntry {
  version: string;
  [key: string]: unknown;
}

/**
 * Chart.yaml keys the index writer computes itself, so they are never copied
 * through from the chart.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'name',
  'version',
  'apiVersion',
  'created',
  'digest',
  'urls',
]);

/**
 * Collect all non-reserved Chart.yaml keys for an index entry. A small
 * denylist prevents overwriting fields computed by the index writer.
 * AppVersion is coerced to string when scalar..
 * @param raw - Parsed Chart.yaml map.
 * @returns The passthrough fields.
 */
function passthroughAllExceptReserved(
  raw: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).flatMap(([k, v]) => {
      if (RESERVED_KEYS.has(k) || v === undefined) {
        return [];
      }
      const scalar = typeof v === 'string' || typeof v === 'number';
      return [[k, k === 'appVersion' && scalar ? String(v) : v]];
    }),
  );
}

/**
 * Parse index.yaml text, turning a YAML syntax problem into a coded error
 * that names the file.
 * @param text - Index.yaml content.
 * @param file - Path of the file, for the message.
 * @returns The parsed value, whatever its shape.
 * @throws SemanticReleaseError (`EINVALIDINDEX`) when it does not parse.
 */
function parseIndex(text: string, file: string): unknown {
  try {
    return yaml.parse(text);
  } catch (error) {
    throw new SemanticReleaseError(
      `${file} is not valid YAML.`,
      'EINVALIDINDEX',
      `${file}: ${messageOf(error)}`,
    );
  }
}

/**
 * The members of a document other than the named ones, in their order.
 * @param doc - The document.
 * @param omit - Keys to leave out.
 * @returns The remaining members.
 */
function without(
  doc: Readonly<Record<string, unknown>>,
  omit: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(doc).filter(([key]) => !omit.includes(key)),
  );
}

/**
 * The Helm chart repository index (`index.yaml`) in a directory. It is
 * immutable: adding a chart returns the updated repository, and saving writes
 * it and returns it.
 */
export class ChartRepository {
  private readonly file: string;

  private readonly entries: Readonly<Record<string, unknown>>;

  private readonly rest: Readonly<Record<string, unknown>>;

  /**
   * @param file - Path of the index.yaml this repository is saved to.
   * @param entries - The chart entries, kept as loaded.
   * @param rest - Every other member of the document, in order.
   */
  private constructor(
    file: string,
    entries: Readonly<Record<string, unknown>>,
    rest: Readonly<Record<string, unknown>>,
  ) {
    this.file = file;
    this.entries = entries;
    this.rest = rest;
  }

  /**
   * Open the repository index in a directory: the existing `index.yaml`, or
   * an empty repository when there is none. An absent or null `entries` means
   * empty.
   * @param directory - Directory that holds (or will hold) `index.yaml`.
   * @returns The repository.
   * @throws SemanticReleaseError (`EINVALIDINDEX`) when the file is not valid
   *   YAML, is not a mapping, or its `entries` is not a mapping.
   */
  static open(directory: string): ChartRepository {
    const file = path.join(directory, 'index.yaml');
    if (!fs.existsSync(file)) {
      return new ChartRepository(file, {}, {});
    }
    const parsed = parseIndex(fs.readFileSync(file, 'utf8'), file);
    if (parsed === null || parsed === undefined) {
      return new ChartRepository(file, {}, {});
    }
    if (!isRecord(parsed)) {
      throw new SemanticReleaseError(
        'The existing Helm index is not a YAML mapping.',
        'EINVALIDINDEX',
        `Refusing to overwrite ${file}; fix or remove it.`,
      );
    }
    const entries = parsed.entries ?? {};
    if (!isRecord(entries)) {
      throw new SemanticReleaseError(
        'The "entries" of the existing Helm index is not a YAML mapping.',
        'EINVALIDINDEX',
        `Refusing to overwrite ${file}; fix or remove it.`,
      );
    }
    return new ChartRepository(
      file,
      entries,
      without(parsed, ['apiVersion', 'entries']),
    );
  }

  /**
   * Add a packaged chart to the repository. The entry includes fields
   * computed here and all non-reserved Chart.yaml fields. Extra fields are
   * merged last. An existing entry with the same version is replaced rather
   * than duplicated.
   * @param chart - The chart that was packaged.
   * @param pkg - Its package.
   * @param baseUrl - Base URL for absolute URLs. When blank, the file name is
   * used as a relative URL.
   * @param extra - Optional extra fields to merge into the entry.
   * @returns The repository with the chart added.
   * @throws SemanticReleaseError (`EINVALIDINDEX`) when the existing entry
   *   for this chart is not a list.
   */
  add(
    chart: Chart,
    pkg: ChartPackage,
    baseUrl: string,
    extra?: Readonly<Record<string, unknown>>,
  ): ChartRepository {
    const digest = pkg.digest();
    const filename = pkg.fileName;
    const created = new Date().toISOString();

    const urls =
      baseUrl.trim().length > 0
        ? [`${baseUrl.replace(/\/+$/, '')}/${filename}`]
        : [filename];

    const entry: ChartEntry = {
      apiVersion: chart.apiVersion() ?? 'v2',
      name: chart.name(),
      version: chart.version() ?? '',
      created,
      digest,
      urls,
      ...passthroughAllExceptReserved(chart.metadata()),
      ...extra,
    };

    const key = chart.name();
    const previous: unknown = Object.hasOwn(this.entries, key)
      ? this.entries[key]
      : undefined;
    if (
      previous !== undefined &&
      previous !== null &&
      !Array.isArray(previous)
    ) {
      throw new SemanticReleaseError(
        `The existing Helm index entry for "${key}" is not a list.`,
        'EINVALIDINDEX',
        'Fix or remove it on the gh-pages branch before publishing.',
      );
    }
    const existing: readonly unknown[] = Array.isArray(previous)
      ? previous
      : [];
    const kept = existing.filter(
      (e) => !(isRecord(e) && String(e.version) === String(entry.version)),
    );

    return new ChartRepository(
      this.file,
      { ...this.entries, [key]: [entry, ...kept] },
      { ...without(this.rest, ['generated']), generated: created },
    );
  }

  /**
   * Write the repository to its `index.yaml`. Parent folders are created
   * when missing.
   * @returns This repository.
   */
  save(): ChartRepository {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      this.file,
      yaml.stringify(
        { apiVersion: 'v1', entries: this.entries, ...this.rest },
        { lineWidth: 0 },
      ),
      'utf8',
    );
    return this;
  }
}
