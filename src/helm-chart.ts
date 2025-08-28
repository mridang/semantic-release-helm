import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

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
    const parsed = (yaml.parse(rawText) ?? {}) as ChartYaml;

    const normalized: ChartYaml = { ...parsed };
    if (typeof normalized.name !== 'string') {
      normalized.name = String(normalized.name ?? '');
    }
    if (normalized.version !== undefined) {
      normalized.version = String(normalized.version);
    }
    if (normalized.apiVersion !== undefined) {
      normalized.apiVersion = String(normalized.apiVersion);
    }

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
