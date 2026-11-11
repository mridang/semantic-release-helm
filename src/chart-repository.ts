/**
 * @file Maintains the Helm chart repository index.yaml that lists packaged chart versions.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import type { Chart } from './chart.js';
import type { ChartPackage } from './chart-package.js';
import SemanticReleaseError from '@semantic-release/error';
import { messageOf } from './utils/error.js';
import { isRecord } from './utils/object.js';

/**
 * Remove trailing slashes, and leading ones too when asked. Equivalent to the
 * `/\/+$/` and `/^\/+|\/+$/g` replacements, but a single linear pass.
 * @param text - Text that may start or end with slashes.
 * @param leading - Whether leading slashes are removed as well.
 * @returns The text without the slashes.
 * @example
 * ```ts
 * trimSlashes('/a/b//', true); // 'a/b'
 * ```
 */
function trimSlashes(text: string, leading: boolean): string {
  let start = 0;
  let end = text.length;
  while (leading && start < end && text.charAt(start) === '/') {
    start += 1;
  }
  while (end > start && text.charAt(end - 1) === '/') {
    end -= 1;
  }
  return text.slice(start, end);
}

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
 * Collect the Chart.yaml keys that are copied into an index entry as they are. Reserved keys
 * are dropped, and an appVersion given as a number is stored as a string.
 * @param raw - The parsed Chart.yaml mapping.
 * @returns The keys to copy into the entry.
 * @example
 * ```ts
 * passthroughAllExceptReserved({ name: 'app', home: 'https://example.com', appVersion: 2 });
 * // { home: 'https://example.com', appVersion: '2' }
 * ```
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
 * Parse index.yaml text, turning a YAML syntax problem into a coded error that names the file.
 * @param text - The index.yaml content.
 * @param file - Path of the file, for the message.
 * @returns The parsed value, whatever its shape.
 * @throws SemanticReleaseError (`EINVALIDINDEX`) when it does not parse.
 * @example
 * ```ts
 * parseIndex('apiVersion: v1\nentries: {}\n', '/repo/gh-pages/index.yaml');
 * ```
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
 * The members of a document other than the named ones, in their original order.
 * @param doc - The document.
 * @param omit - Keys to leave out.
 * @returns The remaining members.
 * @example
 * ```ts
 * without({ apiVersion: 'v1', entries: {}, generated: 'now' }, ['apiVersion', 'entries']);
 * // { generated: 'now' }
 * ```
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
   * Create a repository from its parsed parts. Use ChartRepository.open to load one from disk.
   * @param file - Path of the index.yaml this repository is saved to.
   * @param entries - The chart entries, kept as loaded.
   * @param rest - Every other member of the document, in order.
   * @example
   * ```ts
   * const repo = ChartRepository.open('/repo/gh-pages');
   * ```
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
   * Open the repository index in a directory: the existing index.yaml, or an empty repository when
   * there is none. An absent or null entries member means empty.
   * @param directory - Directory that holds, or will hold, index.yaml.
   * @returns The repository loaded from the index, or an empty one.
   * @throws SemanticReleaseError (`EINVALIDINDEX`) when the file is not valid YAML, is not a
   * mapping, or its entries member is not a mapping.
   * @example
   * ```ts
   * const repo = ChartRepository.open('/repo/gh-pages');
   * ```
   */
  static open(directory: string): ChartRepository {
    const file = path.join(directory, 'index.yaml');
    // eslint-disable-next-line n/no-sync -- ChartRepository.open and save are called synchronously by gh-pages.ts and test/gh-pages.test.ts, so async would ripple beyond this shard
    if (!fs.existsSync(file)) {
      return new ChartRepository(file, {}, {});
    }
    // eslint-disable-next-line n/no-sync -- ChartRepository.open and save are called synchronously by gh-pages.ts and test/gh-pages.test.ts, so async would ripple beyond this shard
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
   * Add a packaged chart to the repository. The entry holds the fields computed here and every
   * non-reserved Chart.yaml field, with extra fields merged last. An existing entry with the same
   * version is replaced rather than duplicated.
   * @param chart - The chart that was packaged.
   * @param pkg - Its package.
   * @param baseUrl - Base URL for absolute URLs. When blank, the file name is used as a relative URL.
   * @param extra - Optional extra fields to merge into the entry.
   * @returns The repository with the chart added.
   * @throws SemanticReleaseError (`EINVALIDINDEX`) when the existing entry for this chart is not a
   * list.
   * @example
   * ```ts
   * const updated = ChartRepository.open('/repo/gh-pages').add(chart, pkg, 'https://charts.example.com');
   * ```
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
        ? [`${trimSlashes(baseUrl, false)}/${filename}`]
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
   * Write the repository to its index.yaml, creating parent folders when they are missing.
   * @returns This repository.
   * @example
   * ```ts
   * ChartRepository.open('/repo/gh-pages').save();
   * ```
   */
  save(): ChartRepository {
    // eslint-disable-next-line n/no-sync -- ChartRepository.open and save are called synchronously by gh-pages.ts and test/gh-pages.test.ts, so async would ripple beyond this shard
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // eslint-disable-next-line n/no-sync -- ChartRepository.open and save are called synchronously by gh-pages.ts and test/gh-pages.test.ts, so async would ripple beyond this shard
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
