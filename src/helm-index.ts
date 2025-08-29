import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as yaml from 'yaml';
import { HelmChart } from './helm-chart.js';

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

/**
 * Copy all non-reserved Chart.yaml keys into the target entry map.
 * A small denylist prevents overwriting fields computed by the
 * index writer. appVersion is coerced to string when scalar.
 *
 * @param raw Parsed Chart.yaml map.
 * @param into Mutable entry map to receive passthrough fields.
 */
function passthroughAllExceptReserved(
  raw: Record<string, unknown>,
  into: Record<string, unknown>,
): void {
  const reserved = new Set([
    'name',
    'version',
    'apiVersion',
    'created',
    'digest',
    'urls',
  ]);

  for (const [k, v] of Object.entries(raw)) {
    if (reserved.has(k)) continue;
    if (v === undefined) continue;

    if (k === 'appVersion') {
      if (typeof v === 'string' || typeof v === 'number') {
        into[k] = String(v);
        continue;
      }
    }

    into[k] = v;
  }
}

/**
 * A mutable Helm index that can be loaded, merged, and serialized.
 * Methods return new instances to make merges predictable in tests.
 */
export class HelmIndex {
  private doc: HelmIndexDoc = { apiVersion: 'v1', entries: {} };

  /**
   * Return an empty index with no entries.
   */
  static empty(): HelmIndex {
    const idx = new HelmIndex();
    idx.doc = { apiVersion: 'v1', entries: {} };
    return idx;
  }

  /**
   * Load an index from disk when present, otherwise create a fresh
   * empty index. Missing sections are normalized for robustness.
   *
   * @param indexPath Path to an index.yaml file.
   */
  static fromFile(indexPath: string): HelmIndex {
    if (fs.existsSync(indexPath)) {
      const parsed = yaml.parse(fs.readFileSync(indexPath, 'utf8')) as
        | HelmIndexDoc
        | undefined;

      const idx = new HelmIndex();
      idx.doc = parsed ?? { apiVersion: 'v1', entries: {} };
      if (!idx.doc.entries) idx.doc.entries = {};
      idx.doc.apiVersion = 'v1';
      return idx;
    }

    return HelmIndex.empty();
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
    extra?: Record<string, unknown>,
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
    };

    passthroughAllExceptReserved(chart.raw(), entry);

    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        (entry as Record<string, unknown>)[k] = v;
      }
    }

    const next = HelmIndex.empty();
    next.doc = {
      apiVersion: 'v1',
      entries: { ...this.doc.entries },
      generated: created,
    };

    const key = chart.name();
    const existing = Array.isArray(next.doc.entries[key])
      ? next.doc.entries[key]
      : [];

    const filtered = existing.filter(
      (e) => String(e.version) !== String(entry.version),
    );

    next.doc.entries[key] = [entry, ...filtered];
    return next;
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
