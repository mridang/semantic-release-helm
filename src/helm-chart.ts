import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

/**
 * Shape of a Helm `Chart.yaml` file.
 *
 * The interface captures the most common keys used by Helm charts.
 * Unknown keys are not stripped during read/write; this library only
 * reads a file, mutates specific fields in-memory immutably, and then
 * serializes the full document back to YAML.
 */
export interface ChartYaml {
  /**
   * The chart definition schema version. For modern application charts
   * this is typically `"v2"`.
   */
  apiVersion: string;

  /** The chart name. */
  name: string;

  /** The chart version (SemVer expected by Helm). */
  version: string;

  /** Optional application version (free-form; often SemVer). */
  appVersion?: string;

  /** Optional human-readable description. */
  description?: string;

  /** Optional chart type (e.g., `"application"`). */
  type?: string;

  /** Optional icon URL shown by some UIs. */
  icon?: string;

  /** Optional Kubernetes version constraint. */
  kubeVersion?: string;

  /** Optional chart maintainers list. */
  maintainers?: Array<{
    /** Maintainer display name. */
    name: string;
    /** Optional email address. */
    email?: string;
    /** Optional home page URL. */
    url?: string;
  }>;
}

/**
 * Immutable representation of a Helm chart. Instances are created via
 * {@link HelmChart.from}. All mutator-like operations return *new*
 * instances; the original object remains unchanged.
 *
 * ### Invariants
 *
 * - The instance always has a valid `name` and `version`.
 * - The YAML structure round-trips: fields not edited are preserved.
 *
 * ### Example
 *
 * ```ts
 * import { HelmChart } from "./helm-chart.js";
 *
 * const chart = HelmChart.from("charts/app");
 * const bumped = chart.withVersion("1.2.3");
 * bumped.saveTo();                    // overwrite Chart.yaml in-place
 * bumped.saveTo("/tmp/Chart.yaml");   // or write to a different path
 *
 * console.log(chart.version());       // old version
 * console.log(bumped.version());      // "1.2.3"
 * ```
 */
export class HelmChart {
  /** Absolute or relative path to the chart directory. */
  private readonly chartDir: string;

  /** Parsed and frozen contents of `Chart.yaml`. */
  private readonly chart: ChartYaml;

  private constructor(chartDir: string, chart: ChartYaml) {
    this.chartDir = chartDir;
    this.chart = Object.freeze({ ...chart });
  }

  /**
   * Load a chart from a directory containing `Chart.yaml`.
   *
   * @throws Error if the file is missing or does not contain the
   *         required `name` and `version` fields.
   */
  static from(chartDir: string): HelmChart {
    const chartFile = path.join(chartDir, 'Chart.yaml');
    const raw = fs.readFileSync(chartFile, 'utf8');
    const parsed = yaml.parse(raw) as ChartYaml;

    if (
      typeof parsed?.name !== 'string' ||
      typeof parsed?.version !== 'string'
    ) {
      throw new Error('Invalid Chart.yaml');
    }

    return new HelmChart(chartDir, parsed);
  }

  /** The chart name (immutable). */
  name(): string {
    return this.chart.name;
  }

  /** The chart version (immutable). */
  version(): string {
    return this.chart.version;
  }

  /**
   * Return a new chart with an updated `version`.
   *
   * @param version Non-empty string (SemVer recommended).
   * @throws Error if `version` is falsy.
   */
  withVersion(version: string): HelmChart {
    if (!version) {
      throw new Error('Version must be non-empty');
    }
    const next: ChartYaml = { ...this.chart, version };
    return new HelmChart(this.chartDir, next);
  }

  // noinspection JSUnusedGlobalSymbols
  /**
   * Return a new chart with an updated `appVersion`.
   *
   * @param appVersion Non-empty string.
   * @throws Error if `appVersion` is falsy.
   */
  withAppVersion(appVersion: string): HelmChart {
    if (!appVersion) {
      throw new Error('appVersion must be non-empty');
    }
    const next: ChartYaml = { ...this.chart, appVersion };
    return new HelmChart(this.chartDir, next);
  }

  /**
   * Serialize the current chart to YAML. Unknown keys (present in the
   * original file) are preserved.
   */
  toYAML(): string {
    return yaml.stringify(this.chart);
  }

  /**
   * Absolute path to the `Chart.yaml` within this chart directory.
   */
  chartFilePath(): string {
    return path.join(this.chartDir, 'Chart.yaml');
  }

  /**
   * Write the current chart to disk.
   *
   * @param filePath Optional explicit path. If omitted, writes to the
   *                 `Chart.yaml` within the original chart directory.
   *
   * ### Example
   *
   * ```ts
   * const chart = HelmChart.from("charts/app").withVersion("1.2.3");
   * chart.saveTo(); // overwrite in-place
   * chart.saveTo("/tmp/Chart.yaml"); // alternate location
   * ```
   */
  saveTo(filePath?: string): void {
    const out = filePath ? filePath : this.chartFilePath();
    const parent = path.dirname(out);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    fs.writeFileSync(out, this.toYAML(), 'utf8');
  }
}
