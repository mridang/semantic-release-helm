import * as fs from 'fs';
// @ts-expect-error since this is not typed
import { Context, PluginConfig } from 'semantic-release';
// @ts-expect-error since this is not typed
import SemanticReleaseError from '@semantic-release/error';
import { execSync } from 'node:child_process';
import * as yaml from 'yaml';

/**
 * Configuration for the Helm OCI release plugin. The plugin updates the
 * chart version, validates rendering, generates docs via helm-docs,
 * packages the chart, and pushes the package to an OCI registry. Pair it
 * with @semantic-release/github to upload the .tgz (and optional .prov)
 * as GitHub Release assets.
 */
export interface HelmPluginConfig extends PluginConfig {
  chartPath: string;
  ociRepo?: string;
  docsArgs?: string[];
  helmImage?: string;
  docsImage?: string;
}

/**
 * Minimal structure for Chart.yaml. Only common fields are typed to
 * preserve unknown keys across parse/serialize.
 */
export interface ChartYaml {
  name: string;
  version?: string;
  [key: string]: string | number | boolean | object | undefined;
}

/**
 * Execute a host shell command and return trimmed stdout. On failure,
 * logs stdout/stderr and throws the original error so callers see the
 * exact underlying problem (e.g., helm lint diagnostics).
 *
 * @param cmd The command line to run, exactly as it would be typed.
 * @param cwd The working directory for command execution.
 * @param logger The semantic-release logger for structured logging.
 * @returns The command's trimmed stdout (may be an empty string).
 */
function runHostCmd(
  cmd: string,
  cwd: string,
  logger: Context['logger'],
): string {
  logger.log(`$ ${cmd}`);
  try {
    const out: string = execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' });
    if (out.trim().length > 0) {
      logger.log(out.trim());
    } else {
      logger.log('(no output)');
    }
    return out.trim();
  } catch (err: unknown) {
    logger.error(`Command failed: ${cmd}`);
    if (typeof err === 'object' && err !== null) {
      const maybe: {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      } = err as {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      };
      const out: string =
        typeof maybe.stdout === 'string'
          ? maybe.stdout
          : Buffer.isBuffer(maybe.stdout)
            ? maybe.stdout.toString('utf8')
            : '';
      const errOut: string =
        typeof maybe.stderr === 'string'
          ? maybe.stderr
          : Buffer.isBuffer(maybe.stderr)
            ? maybe.stderr.toString('utf8')
            : '';
      if (out.trim().length > 0) {
        logger.error(out.trim());
      }
      if (errOut.trim().length > 0) {
        logger.error(errOut.trim());
      }
      if (maybe.message !== undefined && maybe.message.length > 0) {
        logger.error(maybe.message);
      }
    }
    throw err;
  }
}

/**
 * Run a Dockerized CLI with the given image and arguments. The repo root
 * is mounted at /apps and used as the container working directory. Adds
 * a host-gateway mapping so containers can reach host services via the
 * host.docker.internal name on Linux/macOS/Windows.
 *
 * @param image The Docker image name:tag to execute.
 * @param args The arguments passed to the container entrypoint.
 * @param cwd The host directory mounted into /apps inside the container.
 * @param logger The semantic-release logger for command and output logs.
 */
function runDockerCmd(
  image: string,
  args: string[],
  cwd: string,
  logger: Context['logger'],
): void {
  const full: string = [
    'docker run --rm',
    '--add-host=host.docker.internal:host-gateway',
    `-v ${cwd}:/apps`,
    '-w /apps',
    image,
    ...args,
  ].join(' ');
  void runHostCmd(full, cwd, logger);
}

/**
 * Pull a Docker image to fail fast if it cannot be fetched in CI. This
 * reduces surprises during later steps when the image would otherwise be
 * used for the first time.
 *
 * @param image The Docker image reference to pull (name:tag or digest).
 * @param logger The semantic-release logger for command and output logs.
 */
function verifyDockerImage(image: string, logger: Context['logger']): void {
  const cmd: string = `docker pull ${image}`;
  logger.log(`$ ${cmd}`);
  try {
    const out: string = execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
    if (out.trim().length > 0) {
      logger.log(out.trim());
    } else {
      logger.log('(no output)');
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new SemanticReleaseError(
        `Failed to pull Docker image: ${image}`,
        'EIMAGEPULLFAILED',
        err.message,
      );
    } else {
      throw new SemanticReleaseError(
        `Failed to pull Docker image: ${image}`,
        'EIMAGEPULLFAILED',
        'Unknown error',
      );
    }
  }
}

/**
 * Update Chart.yaml with a new version while preserving all other fields.
 * Returns the updated YAML as a string; the caller persists it to disk.
 *
 * @param rawYaml The existing Chart.yaml contents as a string.
 * @param version The version to set in the Chart.yaml.
 * @returns A new YAML string with the updated version field.
 */
function setChartVersion(rawYaml: string, version: string): string {
  const parsed: ChartYaml = yaml.parse(rawYaml) as ChartYaml;
  const updated: ChartYaml = { ...parsed, version };
  return yaml.stringify(updated);
}

/**
 * Verify that Docker is available, required images can be pulled, and the
 * chart exists. This prepares the environment for later steps.
 *
 * @param pluginConfig The plugin configuration provided by the user.
 * @param context The semantic-release context containing env and logger.
 * @throws {SemanticReleaseError} On missing Docker, images, or chart.
 */
export async function verifyConditions(
  pluginConfig: HelmPluginConfig,
  context: Context,
): Promise<void> {
  const { logger, cwd } = context;

  let dockerOk: boolean = true;
  try {
    void runHostCmd('docker version', cwd, logger);
  } catch {
    dockerOk = false;
  }

  if (dockerOk) {
    const helmImage: string = pluginConfig.helmImage ?? 'alpine/helm:3.15.2';
    const docsImage: string =
      pluginConfig.docsImage ?? 'jnorwood/helm-docs:v1.14.2';
    verifyDockerImage(helmImage, logger);
    verifyDockerImage(docsImage, logger);
  } else {
    throw new SemanticReleaseError(
      'Docker not available.',
      'ENODOCKER',
      'Docker must be installed and available on PATH.',
    );
  }

  const chartYamlPath: string = `${cwd}/${pluginConfig.chartPath}/Chart.yaml`;
  if (fs.existsSync(chartYamlPath)) {
    logger.log(`Found chart: ${chartYamlPath}`);
  } else {
    throw new SemanticReleaseError(
      'Chart.yaml not found.',
      'EMISSINGCHARTYAML',
      `No Chart.yaml found in ${pluginConfig.chartPath}.`,
    );
  }
}

/**
 * Prepare the release by updating the chart version, validating the chart
 * with lint and template, generating documentation with helm-docs, and
 * packaging the chart into dist/charts.
 *
 * @param pluginConfig The plugin configuration provided by the user.
 * @param context The semantic-release context containing env and logger.
 * @throws {SemanticReleaseError} If the version is missing or chart absent.
 */
export async function prepare(
  pluginConfig: HelmPluginConfig,
  context: Context,
): Promise<void> {
  const { cwd, nextRelease, logger } = context;
  const version: string | undefined = nextRelease?.version;

  if (version !== undefined) {
    const chartYamlPath: string = `${cwd}/${pluginConfig.chartPath}/Chart.yaml`;
    if (fs.existsSync(chartYamlPath)) {
      const raw: string = fs.readFileSync(chartYamlPath, 'utf8');
      const updatedYaml: string = setChartVersion(raw, version);
      fs.writeFileSync(chartYamlPath, updatedYaml, 'utf8');
      logger.log(`Updated Chart.yaml to version ${version}`);
    } else {
      throw new SemanticReleaseError(
        'Chart.yaml missing during prepare.',
        'EMISSINGCHARTYAML',
        `Expected Chart.yaml in ${pluginConfig.chartPath}.`,
      );
    }

    const helmImage: string = pluginConfig.helmImage ?? 'alpine/helm:3.15.2';
    void runDockerCmd(helmImage, ['lint', pluginConfig.chartPath], cwd, logger);
    void runDockerCmd(
      helmImage,
      ['template', 'sr-check', pluginConfig.chartPath],
      cwd,
      logger,
    );

    const docsImage: string =
      pluginConfig.docsImage ?? 'jnorwood/helm-docs:v1.14.2';

    // Default to using README.md as the template to avoid requiring .gotmpl
    const docsArgs: string[] = pluginConfig.docsArgs ?? [
      '--template-files',
      'README.md',
    ];

    try {
      void runDockerCmd(
        docsImage,
        ['helm-docs', ...docsArgs],
        `${cwd}/${pluginConfig.chartPath}`,
        logger,
      );
      logger.log('helm-docs ran successfully.');
    } catch {
      logger.log('helm-docs failed or missing; skipping docs generation.');
    }

    const outDir: string = `${cwd}/dist/charts`;
    if (fs.existsSync(outDir)) {
      // reuse directory
    } else {
      fs.mkdirSync(outDir, { recursive: true });
    }
    void runDockerCmd(
      helmImage,
      ['package', pluginConfig.chartPath, '-d', 'dist/charts'],
      cwd,
      logger,
    );
    logger.log('Packaged Helm chart into dist/charts.');
  } else {
    throw new SemanticReleaseError(
      'Missing next release version.',
      'ENOVERSION',
      'semantic-release did not provide a nextRelease.version.',
    );
  }
}

/**
 * Publish the packaged chart to an OCI registry when configured. This
 * complements @semantic-release/github, which can upload the .tgz files
 * from dist/charts to the GitHub Release. If no OCI target is provided,
 * the step logs and exits.
 *
 * @param pluginConfig The plugin configuration provided by the user.
 * @param context The semantic-release context containing env and logger.
 * @throws {SemanticReleaseError} If packaging is missing when required.
 */
export async function publish(
  pluginConfig: HelmPluginConfig,
  context: Context,
): Promise<void> {
  const { cwd, logger } = context;
  const helmImage: string = pluginConfig.helmImage ?? 'alpine/helm:3.15.2';

  if (pluginConfig.ociRepo !== undefined) {
    const files: string[] = fs
      .readdirSync(`${cwd}/dist/charts`, { withFileTypes: true })
      .filter((d): boolean => d.isFile() && d.name.endsWith('.tgz'))
      .map((d): string => `dist/charts/${d.name}`);

    if (files.length > 0) {
      for (const tgz of files) {
        void runDockerCmd(
          helmImage,
          ['push', tgz, pluginConfig.ociRepo],
          cwd,
          logger,
        );
      }
      logger.log(`Pushed ${files.length} chart(s) to ${pluginConfig.ociRepo}`);
    } else {
      throw new SemanticReleaseError(
        'No packaged chart found.',
        'ENOPACKAGEDCHART',
        'Prepare step must package chart before publish.',
      );
    }
  } else {
    logger.log('No OCI repository configured; skipping helm push.');
  }
}

export default { verifyConditions, prepare, publish };
