// noinspection JSUnusedGlobalSymbols
// @ts-expect-error semantic-release types are not bundled
import { PluginConfig } from 'semantic-release';

export interface HelmPluginConfig extends PluginConfig {
  /**
   * Path to the chart directory that contains `Chart.yaml`.
   * Example: `"charts/app"`.
   */
  chartPath: string;

  /**
   * Values passed to `helm template` during the prepare step.
   * Useful for charts that require certain values to be set
   * for validation to pass.
   */
  templateValues?: Record<string, unknown>;

  /**
   * OCI repository to push charts to. Example:
   * `"oci://registry.example.com/charts"`. When omitted, OCI publish
   * is skipped and only gh-pages (if enabled) is used.
   */
  ociRepo?: string;

  /**
   * Enables plain HTTP behavior for the OCI registry. When true,
   * Helm will use insecure transport semantics compatible with
   * registries that do not offer TLS.
   */
  ociInsecure?: boolean;

  /**
   * Username for OCI login. When omitted, falls back to the
   * `OCI_USERNAME` environment variable if set.
   */
  ociUsername?: string;

  /**
   * Password for OCI login. When omitted, falls back to the
   * `OCI_PASSWORD` environment variable if set.
   */
  ociPassword?: string;

  /**
   * Extra args for `helm-docs`. Default is `["--template-files=README.md"]`.
   */
  docsArgs?: string[];

  /**
   * Docker image used for Helm CLI. Default is `"alpine/helm:3.15.2"`.
   */
  helmImage?: string;

  /**
   * Docker image used for `helm-docs`. Default is
   * `"jnorwood/helm-docs:v1.14.2"`.
   */
  docsImage?: string;

  /**
   * GitHub Pages configuration block. Enabled by default unless
   * explicitly disabled by setting `enabled: false`.
   */
  ghPages?: {
    /**
     * Enables or disables gh-pages publishing. Default: true.
     */
    enabled?: boolean;

    /**
     * Public base URL used when writing absolute URLs into
     * `index.yaml`. When omitted, relative file names are written.
     * Example: `"https://example.test/charts"`.
     */
    url?: string;

    /**
     * Git remote name used for pushing. Default: `"origin"`.
     */
    repo?: string;

    /**
     * Branch name used for gh-pages content. Default: `"gh-pages"`.
     */
    branch?: string;

    /**
     * Subdirectory in the gh-pages worktree where charts live.
     * Default: `"charts"`.
     */
    dir?: string;
  };
}

/**
 * Parse an `oci://host[:port]/path` by replacing the scheme with
 * `http://` and using the platform `URL` parser. Returns `undefined`
 * when input is empty or parsing fails.
 *
 * This keeps parsing dependency-free and readable while avoiding
 * hand-rolled tokenization.
 *
 * @param repo OCI URL such as `oci://ghcr.io/org/charts`.
 * @returns A `URL` instance or `undefined` if not parseable.
 */
function parseOciAsHttp(repo?: string): URL | undefined {
  if (!repo || repo.length === 0) return undefined;
  const replaced = repo.replace(/^oci:\/\//, 'http://');
  try {
    return new URL(replaced);
  } catch {
    return undefined;
  }
}

/**
 * HelmConfig wraps the raw plugin config and exposes derived values
 * and safe defaults. It centralizes option reading so the plugin code
 * stays small and consistent.
 */
export class HelmConfig {
  private readonly cfg: HelmPluginConfig;

  constructor(cfg: HelmPluginConfig) {
    this.cfg = cfg;
  }

  /**
   * Values for `helm template` during the prepare step.
   *
   * @returns A key-value map or `undefined`.
   */
  getTemplateValues(): Record<string, unknown> | undefined {
    return this.cfg.templateValues;
  }

  /**
   * The chart directory that contains `Chart.yaml`.
   *
   * @returns Chart directory path.
   */
  getChartPath(): string {
    return this.cfg.chartPath;
  }

  /**
   * Docker image used for Helm CLI operations.
   *
   * @returns Image reference with tag.
   */
  getHelmImage(): string {
    return this.cfg.helmImage ?? 'alpine/helm:3.15.2';
  }

  /**
   * Docker image used for `helm-docs`.
   *
   * @returns Image reference with tag.
   */
  getDocsImage(): string {
    return this.cfg.docsImage ?? 'jnorwood/helm-docs:v1.14.2';
  }

  /**
   * Additional arguments for `helm-docs`.
   *
   * @returns Array of CLI arguments.
   */
  getDocsArgs(): string[] {
    return this.cfg.docsArgs ?? ['--template-files=README.md'];
  }

  /**
   * Whether gh-pages publishing is enabled.
   *
   * @returns True when enabled or not explicitly disabled.
   */
  isGhEnabled(): boolean {
    return this.cfg.ghPages?.enabled !== false;
  }

  /**
   * Public base URL used for absolute URLs in `index.yaml`.
   *
   * @returns URL string or `undefined`.
   */
  getGhUrl(): string | undefined {
    return this.cfg.ghPages?.url;
  }

  /**
   * Git remote used for gh-pages push.
   *
   * @returns Remote name.
   */
  getGhRepo(): string {
    return this.cfg.ghPages?.repo ?? 'origin';
  }

  /**
   * Branch used for gh-pages content.
   *
   * @returns Branch name.
   */
  getGhBranch(): string {
    return this.cfg.ghPages?.branch ?? 'gh-pages';
  }

  /**
   * Subdirectory inside the gh-pages worktree for charts.
   *
   * @returns Directory name.
   */
  getGhDir(): string {
    return this.cfg.ghPages?.dir ?? 'charts';
  }

  /**
   * Whether OCI publishing is enabled.
   *
   * @returns True when `ociRepo` is present.
   */
  isOciEnabled(): boolean {
    return typeof this.cfg.ociRepo === 'string' && this.cfg.ociRepo.length > 0;
  }

  /**
   * Raw OCI repository string.
   *
   * @returns `oci://…` string or `undefined`.
   */
  getOciRepo(): string | undefined {
    return this.cfg.ociRepo;
  }

  /**
   * Whether plain HTTP / insecure mode is enabled for OCI.
   *
   * @returns True when insecure is requested.
   */
  getOciInsecure(): boolean {
    return this.cfg.ociInsecure === true;
  }

  /**
   * Resolved OCI username, falling back to `OCI_USERNAME`.
   *
   * @returns Username or `undefined`.
   */
  getOciUsername(): string | undefined {
    return this.cfg.ociUsername ?? process.env.OCI_USERNAME;
  }

  /**
   * Resolved OCI password, falling back to `OCI_PASSWORD`.
   *
   * @returns Password or `undefined`.
   */
  getOciPassword(): string | undefined {
    return this.cfg.ociPassword ?? process.env.OCI_PASSWORD;
  }

  /**
   * True when a username is present for OCI.
   *
   * @returns Boolean presence.
   */
  hasOciUser(): boolean {
    return !!this.getOciUsername();
  }

  /**
   * True when a password is present for OCI.
   *
   * @returns Boolean presence.
   */
  hasOciPass(): boolean {
    return !!this.getOciPassword();
  }

  /**
   * Host extracted from `ociRepo` using standard URL parsing after
   * replacing the scheme with `http://`.
   *
   * @returns Hostname or `undefined`.
   */
  getOciHost(): string | undefined {
    const u = parseOciAsHttp(this.cfg.ociRepo);
    return u?.hostname;
  }

  /**
   * Port extracted from `ociRepo` using standard URL parsing after
   * replacing the scheme with `http://`.
   *
   * @returns Numeric port or `undefined`.
   */
  getOciPort(): number | undefined {
    const u = parseOciAsHttp(this.cfg.ociRepo);
    const p = u?.port ?? '';
    return p.length ? Number(p) : undefined;
  }

  /**
   * Host or `host:port` derived from `ociRepo`.
   *
   * @returns Host with optional port or `undefined`.
   */
  getOciHostPort(): string | undefined {
    const host = this.getOciHost();
    const port = this.getOciPort();
    if (!host) return undefined;
    return typeof port === 'number' ? `${host}:${port}` : host;
  }

  /**
   * Optional `helm push` flag for plain HTTP when insecure is on.
   *
   * @returns `' --plain-http'` or an empty string.
   */
  getOciPlainHttpFlag(): string {
    return this.getOciInsecure() ? ' --plain-http' : '';
  }

  /**
   * Optional `helm registry login` flag for insecure mode.
   *
   * @returns `' --insecure'` or an empty string.
   */
  getOciInsecureLoginFlag(): string {
    return this.getOciInsecure() ? ' --insecure' : '';
  }
}
