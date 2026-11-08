import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from './command-runner.js';
import type { DockerClient } from './docker.js';
import { normalizeReadmeValuesTableFile } from './helm-docs.js';
import { isRecord } from './utils/object.js';
import { quoteWord, shQuote } from './utils/shell.js';

/**
 * Settings of a Helm client.
 */
export interface HelmOptions {
  /** Runs the containers that hold Helm and helm-docs. */
  readonly docker: DockerClient;
  /** Image with the Helm CLI. */
  readonly helmImage: string;
  /** Image with helm-docs. */
  readonly docsImage: string;
  /** Receives progress messages. */
  readonly logger: Logger;
  /** Repository root, where chart paths are resolved. */
  readonly cwd: string;
}

/**
 * What to push to an OCI registry, and how to authenticate.
 */
export interface OciPush {
  /** `host` or `host:port` of the registry. */
  readonly hostPort: string | undefined;
  /** Repository URL, such as `oci://registry.example.test/charts`. */
  readonly repo: string;
  /** Whether to talk plain HTTP and skip TLS verification. */
  readonly insecure: boolean;
  readonly username: string | undefined;
  readonly password: string | undefined;
  /** Packaged charts, relative to the repository root. */
  readonly files: readonly string[];
}

/**
 * Name of the container environment variable that carries the registry
 * password into the script, so it is never part of the script text.
 */
const OCI_PASSWORD_ENV = 'OCI_PASSWORD';

/**
 * Flatten nested objects into dotted keys with string values. Arrays and
 * other non-object values are not descended into; they are stringified.
 *
 * @param record The object to flatten.
 * @param prefix Dotted prefix for the keys, empty at the top level.
 * @returns A flat map such as `{ 'image.tag': 'v1' }`.
 */
function flattenRecord(
  record: Readonly<Record<string, unknown>>,
  prefix = '',
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, value]) => {
      const dotted = prefix.length ? `${prefix}.${key}` : key;
      return isRecord(value)
        ? Object.entries(flattenRecord(value, dotted))
        : [[dotted, String(value)]];
    }),
  );
}

/**
 * Turn template values into `helm template` arguments: one `--set` and one
 * `key=value` per flattened leaf.
 *
 * @param values The configured template values, if any.
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
 * Build the `/bin/sh` script run inside the Helm container to publish
 * charts to an OCI registry. A shell is needed there because the steps are
 * chained; every interpolated value is single-quoted when it needs it. The
 * password is read from the `OCI_PASSWORD` environment variable instead of
 * being written into the script.
 *
 * @param push The registry, credentials and charts.
 * @returns Commands joined with `&&`.
 */
function ociScript(push: OciPush): string {
  const { hostPort, repo, insecure, username, password, files } = push;
  const plainHttpFlag = insecure ? ' --plain-http' : '';
  const insecureLoginFlag = insecure ? ' --insecure' : '';
  const configDir = '/root/.config/helm/registry';
  return [
    ...(insecure && hostPort
      ? [
          `mkdir --parents ${configDir}`,
          `printf %s ${shQuote(`{"auths":{"${hostPort}":{"insecure":true}}}`)} > ${configDir}/config.json`,
        ]
      : []),
    ...(username && password && hostPort
      ? [
          `helm registry login${insecureLoginFlag} --username=${quoteWord(username)} --password="$${OCI_PASSWORD_ENV}" ${quoteWord(hostPort)}`,
        ]
      : []),
    ...files.map(
      (tgz) => `helm push ${quoteWord(tgz)} ${quoteWord(repo)}${plainHttpFlag}`,
    ),
  ].join(' && ');
}

/**
 * Everything the plugin does with Helm: lint, template, package, generate the
 * chart documentation, and push to an OCI registry. Each runs inside a
 * container through the Docker client.
 */
export class HelmClient {
  private readonly options: HelmOptions;

  /**
   * @param options The Docker client, the two images, a logger and the
   *   repository root.
   */
  constructor(options: HelmOptions) {
    this.options = options;
  }

  /**
   * Lint a chart.
   *
   * @param chartPath Chart directory, relative to the repository root.
   */
  async lint(chartPath: string): Promise<void> {
    await this.helm(['lint', chartPath]);
  }

  /**
   * Render a chart to check that it templates, with values set from a nested
   * object.
   *
   * @param chartPath Chart directory, relative to the repository root.
   * @param values Values to set, flattened to `--set key=value`.
   */
  async template(
    chartPath: string,
    values: Readonly<Record<string, unknown>> | undefined,
  ): Promise<void> {
    await this.helm([
      'template',
      'sr-check',
      chartPath,
      ...templateSetArgs(values),
    ]);
  }

  /**
   * Package a chart.
   *
   * @param chartPath Chart directory, relative to the repository root.
   * @param destination Output directory, relative to the repository root.
   */
  async package(chartPath: string, destination: string): Promise<void> {
    await this.helm(['package', chartPath, `--destination=${destination}`]);
  }

  /**
   * Regenerate the chart documentation with helm-docs. A failure is not an
   * error: it is reported through the result and the release goes on.
   *
   * @param chartPath Chart directory, relative to the repository root.
   * @param args Extra arguments for helm-docs.
   * @returns True when the documentation was generated.
   */
  async docs(chartPath: string, args: readonly string[]): Promise<boolean> {
    const { logger, cwd, docker, docsImage } = this.options;
    try {
      const readmePath = path.join(cwd, chartPath, 'README.md');
      if (fs.existsSync(readmePath)) {
        const { changed } = normalizeReadmeValuesTableFile(readmePath);
        logger.log(
          changed
            ? 'helm-docs: normalized README valuesTable block(s)'
            : 'helm-docs: README normalization not needed (no markers found)',
        );
      } else {
        logger.log('helm-docs: README.md not found; skipping normalization');
      }
      await docker.run(docsImage, [
        'helm-docs',
        `--chart-search-root=${chartPath}`,
        ...args,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Log in to an OCI registry when credentials are given, and push the
   * packaged charts. The password reaches the container only through its
   * environment, so it appears in no script, command line or log.
   *
   * @param push The registry, credentials and charts.
   */
  async pushToOci(push: OciPush): Promise<void> {
    await this.options.docker.run(
      this.options.helmImage,
      ['-lc', ociScript(push)],
      {
        entrypoint: '/bin/sh',
        env: push.password ? { [OCI_PASSWORD_ENV]: push.password } : {},
      },
    );
  }

  /**
   * Run the Helm CLI in its container.
   *
   * @param args Arguments for `helm`.
   */
  private async helm(args: readonly string[]): Promise<void> {
    await this.options.docker.run(this.options.helmImage, args);
  }
}
