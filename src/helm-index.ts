import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as yaml from 'yaml';
import { HelmChart } from './helm-chart.js';

/**
 * A single entry inside a Helm `index.yaml` for a specific chart
 * version. Fields beyond the common ones are allowed and preserved.
 */
export interface ChartEntry {
  /** Chart schema version for the packaged chart (usually `"v2"`). */
  apiVersion: string;

  /** Chart name. */
  name: string;

  /** Chart version (SemVer). */
  version: string;

  /** ISO8601 timestamp when the index entry was created. */
  created: string;

  /** SHA256 digest of the `.tgz` archive (hex). */
  digest: string;

  /** HTTP(S) URLs pointing to the `.tgz` archive. */
  urls: string[];

  /** Additional metadata merged in by callers. */
  [key: string]: unknown;
}

/**
 * Root document shape for a Helm repository `index.yaml`.
 */
export interface HelmIndexDoc {
  /** Repository index schema version. */
  apiVersion: 'v1';

  /**
   * Mapping of chart name to a list of entries. Consumers expect the
   * list to be sorted in descending version order (highest first).
   */
  entries: Record<string, ChartEntry[]>;

  /** Optional generated timestamp (ISO8601). */
  generated?: string;
}

/**
 * Compute the SHA256 digest of a file and return it as lowercase hex.
 */
function sha256(file: string): string {
  const h = crypto.createHash('sha256');
  const buf = fs.readFileSync(file);
  h.update(buf);
  return h.digest('hex');
}

/**
 * Immutable representation of a Helm repository index. Instances are
 * created with {@link HelmIndex.empty} or {@link HelmIndex.fromFile}.
 * All mutations return *new* instances.
 *
 * ### Merge semantics
 *
 * - {@link append} inserts or replaces a version for a given chart
 *   name, removes any duplicate of that version, and re-sorts the list
 *   descending by SemVer segments (numeric compare, zero-padded).
 * - Unknown charts remain untouched.
 *
 * ### Example: build an index and write to disk
 *
 * ```ts
 * import { HelmIndex } from "./helm-index.js";
 * import { HelmChart } from "./helm-chart.js";
 *
 * const idx = HelmIndex.fromFile("docs/charts/index.yaml");
 * const chart = HelmChart.from("charts/app");
 *
 * const next = idx.append(
 *   chart,
 *   "dist/charts/app-1.2.3.tgz",
 *   "https://example.com/charts",
 *   { description: "App release" }
 * );
 *
 * next.writeTo("docs/charts/index.yaml");
 * ```
 */
export class HelmIndex {
  /** Frozen document that will be serialized to `index.yaml`. */
  private readonly doc: HelmIndexDoc;

  private constructor(doc: HelmIndexDoc) {
    const safe: HelmIndexDoc = {
      apiVersion: 'v1',
      entries: { ...(doc.entries || {}) },
      generated: doc.generated,
    };
    this.doc = Object.freeze(safe);
  }

  /**
   * Create an empty index.
   */
  static empty(): HelmIndex {
    return new HelmIndex({ apiVersion: 'v1', entries: {} });
  }

  /**
   * Load an index from a YAML file. If the file does not exist, or if
   * the content is invalid, an empty index is returned.
   */
  static fromFile(filePath: string): HelmIndex {
    if (!fs.existsSync(filePath)) {
      return HelmIndex.empty();
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = yaml.parse(raw) as HelmIndexDoc | undefined;

    if (!parsed || parsed.apiVersion !== 'v1') {
      return HelmIndex.empty();
    }
    if (!parsed.entries) {
      return new HelmIndex({ apiVersion: 'v1', entries: {} });
    }
    return new HelmIndex(parsed);
  }

  /**
   * Append (or replace) a chart version and return a new index.
   *
   * If an entry for the same `name@version` exists, it is removed and
   * replaced by the new entry (with updated `created`, `digest`, and
   * `urls`). The final list for that chart is sorted by version in
   * descending order using a numeric segment comparison, so that:
   *
   * - `10.0.0` > `2.9.9`
   * - `1.10.0` > `1.2.0`
   * - `1.0` == `1.0.0` in ordering intent (trailing zeros padded).
   *
   * @param chart    The parsed chart metadata (name + version).
   * @param tgzPath  Path to the packaged `.tgz` archive on disk.
   * @param baseUrl  Base URL where `.tgz` files are hosted. A single
   *                 slash is ensured between `baseUrl` and filename.
   * @param extra    Optional metadata to merge into the entry.
   */
  append(
    chart: HelmChart,
    tgzPath: string,
    baseUrl: string,
    extra?: Record<string, unknown>,
  ): HelmIndex {
    const name = chart.name();
    const version = chart.version();
    const digest = sha256(tgzPath);
    const filename = path.basename(tgzPath);
    const url = `${baseUrl.replace(/\/$/, '')}/${filename}`;
    const created = new Date().toISOString();

    const nextEntry: ChartEntry = Object.freeze({
      apiVersion: 'v2',
      name,
      version,
      created,
      digest,
      urls: [url],
      ...(extra || {}),
    });

    const existingForName: ChartEntry[] = this.doc.entries[name]
      ? [...this.doc.entries[name]]
      : [];

    // Drop any existing entry for the same version.
    const filtered: ChartEntry[] = existingForName.filter(
      (e) => e.version !== version,
    );

    // Add the fresh one and sort descending by dotted numeric segments.
    const merged: ChartEntry[] = [...filtered, nextEntry];
    const sorted: ChartEntry[] = [...merged].sort((a, b) => {
      const as = a.version.split('.').map((n) => Number(n));
      const bs = b.version.split('.').map((n) => Number(n));
      for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
        const ai = Number.isFinite(as[i]) ? as[i] : 0;
        const bi = Number.isFinite(bs[i]) ? bs[i] : 0;
        if (ai !== bi) {
          return bi - ai;
        }
      }
      return 0;
    });

    // Rebuild the entries map immutably.
    const nextEntries: Record<string, ChartEntry[]> = Object.keys(
      this.doc.entries,
    ).reduce(
      (acc, key) => {
        if (key === name) {
          return { ...acc, [key]: sorted };
        }
        return { ...acc, [key]: [...this.doc.entries[key]] };
      },
      {} as Record<string, ChartEntry[]>,
    );

    if (!this.doc.entries[name]) {
      return new HelmIndex({
        apiVersion: 'v1',
        entries: { ...nextEntries, [name]: sorted },
        generated: created,
      });
    }

    return new HelmIndex({
      apiVersion: 'v1',
      entries: nextEntries,
      generated: created,
    });
  }

  /**
   * Serialize the current index to YAML.
   *
   * ### Example
   *
   * ```ts
   * const idx = HelmIndex.empty();
   * const yamlText = idx.toYAML();
   * console.log(yamlText);
   * ```
   */
  toYAML(): string {
    return yaml.stringify(this.doc);
  }

  /**
   * Write the current index to a file, creating parent directories if
   * necessary.
   *
   * @param filePath Destination path (e.g., `docs/charts/index.yaml`).
   *
   * ### Example
   *
   * ```ts
   * const idx = HelmIndex.empty();
   * idx.writeTo("docs/charts/index.yaml");
   * ```
   */
  writeTo(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, this.toYAML(), 'utf8');
  }
}
