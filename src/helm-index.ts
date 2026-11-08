import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'yaml';
import { HelmChart } from './helm-chart.js';
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
 * In-memory representation of a Helm repository index document. The
 * structure mirrors Helm's index.yaml format.
 */
export interface HelmIndexDoc {
  apiVersion: 'v1';
  entries: Record<string, ChartEntry[]>;
  generated?: string;
}

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
 * appVersion is coerced to string when scalar.
 *
 * @param raw Parsed Chart.yaml map.
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
 * Read the entries of a parsed index.yaml. Anything that is not a list of
 * objects with a string or numeric version is dropped.
 *
 * @param parsed The parsed document.
 * @returns A map of chart name to its entries.
 */
function entriesOf(parsed: unknown): Record<string, ChartEntry[]> {
  const raw =
    isRecord(parsed) && isRecord(parsed.entries) ? parsed.entries : {};
  return Object.fromEntries(
    Object.entries(raw).flatMap(([name, list]) =>
      Array.isArray(list)
        ? [
            [
              name,
              list.flatMap((e: unknown) =>
                isRecord(e) &&
                (typeof e.version === 'string' || typeof e.version === 'number')
                  ? [{ ...e, version: String(e.version) }]
                  : [],
              ),
            ],
          ]
        : [],
    ),
  );
}

/**
 * An immutable Helm index that can be loaded, merged, and serialized.
 * Methods return new instances to make merges predictable in tests.
 */
export class HelmIndex {
  private readonly doc: HelmIndexDoc;

  private constructor(doc: HelmIndexDoc) {
    this.doc = doc;
  }

  /**
   * Return an empty index with no entries.
   */
  static empty(): HelmIndex {
    return new HelmIndex({ apiVersion: 'v1', entries: {} });
  }

  /**
   * Load an index from disk when present, otherwise create a fresh
   * empty index. Missing sections are normalized for robustness.
   *
   * @param indexPath Path to an index.yaml file.
   */
  static fromFile(indexPath: string): HelmIndex {
    if (!fs.existsSync(indexPath)) {
      return HelmIndex.empty();
    }
    const parsed: unknown = yaml.parse(fs.readFileSync(indexPath, 'utf8'));
    return new HelmIndex({
      ...(isRecord(parsed) ? parsed : {}),
      apiVersion: 'v1',
      entries: entriesOf(parsed),
    });
  }

  /**
   * Append a packaged chart to the index. The entry includes fields
   * computed by this writer and all non-reserved Chart.yaml fields.
   * Extra fields are merged last. Existing versions are replaced by
   * version string rather than duplicated.
   *
   * @param chart Parsed chart instance.
   * @param packagedTgzAbsPath Absolute path to the packaged .tgz.
   * @param baseUrl Base URL for absolute URLs. When blank, relative
   *                file names are used instead.
   * @param extra Optional extra fields to merge into the entry.
   */
  append(
    chart: HelmChart,
    packagedTgzAbsPath: string,
    baseUrl: string,
    extra?: Readonly<Record<string, unknown>>,
  ): HelmIndex {
    const bytes = fs.readFileSync(packagedTgzAbsPath);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const filename = path.basename(packagedTgzAbsPath);
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
      ...passthroughAllExceptReserved(chart.raw()),
      ...extra,
    };

    const key = chart.name();
    const kept = (this.doc.entries[key] ?? []).filter(
      (e) => String(e.version) !== String(entry.version),
    );

    return new HelmIndex({
      apiVersion: 'v1',
      entries: { ...this.doc.entries, [key]: [entry, ...kept] },
      generated: created,
    });
  }

  /**
   * Serialize the index to YAML at the given path. Parent folders
   * are created when missing.
   *
   * @param indexPath Destination path for the index.yaml file.
   */
  writeTo(indexPath: string): void {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, yaml.stringify(this.doc), 'utf8');
  }
}
