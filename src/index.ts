// file: src/index.ts
import * as fs from 'fs';
// @ts-expect-error since this is not typed
import { Context, PluginConfig } from 'semantic-release';
// @ts-expect-error since this is not typed
import SemanticReleaseError from '@semantic-release/error';
import { execSync } from 'node:child_process';
import * as yaml from 'yaml';

/**
 * Configuration for the Helm semantic-release plugin.
 *
 * The plugin updates the chart version, validates the chart with Helm,
 * runs `helm-docs` for README generation, packages the chart, and can
 * push it to an OCI registry.
 */
export interface HelmPluginConfig extends PluginConfig {
  /** Path to the chart directory (relative to project root). */
  chartPath: string;
  /** OCI repository URL (e.g. `oci://registry:5000/charts`). */
  ociRepo?: string;
  /** If true, mark the OCI registry as insecure (HTTP/plain). */
  ociInsecure?: boolean;
  /** Username for OCI login. If omitted, defaults to "anonymous". */
  ociUsername?: string;
  /** Password for OCI login. If omitted, defaults to "anonymous". */
  ociPassword?: string;
  /** Extra arguments for `helm-docs` invocation. */
  docsArgs?: string[];
  /** Docker image for Helm CLI. Defaults to `alpine/helm:3.15.2`. */
  helmImage?: string;
  /** Docker image for helm-docs CLI. Defaults to `jnorwood/helm-docs:v1.14.2`. */
  docsImage?: string;
}

/**
 * Minimal Chart.yaml representation for version updates.
 */
export interface ChartYaml {
  name: string;
  version?: string;
  [key: string]: string | number | boolean | object | undefined;
}

/**
 * Run a host-side shell command, capturing output and logging
 * via semantic-release's logger.
 *
 * @param cmd   Full shell command to execute.
 * @param cwd   Working directory to run the command from.
 * @param logger Semantic-release logger for structured logging.
 * @returns Captured stdout as string (trimmed).
 * @throws Error if the command exits non-zero.
 */
function runHostCmd(
  cmd: string,
  cwd: string,
  logger: Context['logger'],
): string {
  logger.log(`$ ${cmd}`);
  try {
    const out: string = execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' });
    if (out.trim().length > 0) logger.log(out.trim());
    else logger.log('(no output)');
    return out.trim();
  } catch (err: unknown) {
    logger.error(`Command failed: ${cmd}`);
    if (typeof err === 'object' && err !== null) {
      const e = err as {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      };
      const out = Buffer.isBuffer(e.stdout)
        ? e.stdout.toString('utf8')
        : String(e.stdout ?? '');
      const errOut = Buffer.isBuffer(e.stderr)
        ? e.stderr.toString('utf8')
        : String(e.stderr ?? '');
      if (out.trim().length > 0) logger.error(out.trim());
      if (errOut.trim().length > 0) logger.error(errOut.trim());
      if (e.message && e.message.length > 0) logger.error(e.message);
    }
    throw err;
  }
}

/**
 * Run a Dockerized command, mounting the given `cwd` into `/apps`
 * and using it as the working directory.
 *
 * @param image Docker image to run (e.g. Helm or helm-docs).
 * @param args  Arguments to pass to the container entrypoint.
 * @param cwd   Host working directory, mounted into `/apps`.
 * @param logger Logger for structured command output.
 */
function runDockerCmd(
  image: string,
  args: string[],
  cwd: string,
  logger: Context['logger'],
): void {
  const full = [
    'docker run',
    '--rm',
    '--add-host=host.docker.internal:host-gateway',
    `--volume=${cwd}:/apps`,
    '--workdir=/apps',
    image,
    ...args,
  ].join(' ');
  void runHostCmd(full, cwd, logger);
}

/**
 * Run a shell script inside a Docker container with `/bin/sh -lc`.
 * Useful for chaining multiple commands in one container run.
 *
 * @param image Docker image to run.
 * @param script Shell script to execute inside the container.
 * @param cwd Host working directory, mounted into `/apps`.
 * @param logger Logger for structured command output.
 */
function runDockerShell(
  image: string,
  script: string,
  cwd: string,
  logger: Context['logger'],
): void {
  const full = [
    'docker run',
    '--rm',
    '--add-host=host.docker.internal:host-gateway',
    `--volume=${cwd}:/apps`,
    '--workdir=/apps',
    '--entrypoint=/bin/sh',
    image,
    '-lc',
    JSON.stringify(script),
  ].join(' ');
  void runHostCmd(full, cwd, logger);
}

/**
 * Verify that a Docker image can be pulled.
 * Throws a semantic-release error if the pull fails.
 *
 * @param image Image name (e.g. `alpine/helm:3.15.2`).
 * @param logger Logger for logging progress and errors.
 */
function verifyDockerImage(image: string, logger: Context['logger']): void {
  const cmd = `docker pull ${image}`;
  logger.log(`$ ${cmd}`);
  try {
    const out: string = execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
    if (out.trim().length > 0) logger.log(out.trim());
    else logger.log('(no output)');
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new SemanticReleaseError(
        `Failed to pull Docker image: ${image}`,
        'EIMAGEPULLFAILED',
        err.message,
      );
    }
    throw new SemanticReleaseError(
      `Failed to pull Docker image: ${image}`,
      'EIMAGEPULLFAILED',
      'Unknown error',
    );
  }
}

/**
 * Update the `version` field of a Chart.yaml, preserving all
 * other keys and formatting.
 *
 * @param rawYaml  Raw Chart.yaml contents.
 * @param version  New version string to set.
 * @returns Updated YAML string.
 */
function setChartVersion(rawYaml: string, version: string): string {
  const parsed: ChartYaml = yaml.parse(rawYaml) as ChartYaml;
  const updated: ChartYaml = { ...parsed, version };
  return yaml.stringify(updated);
}

/**
 * Verify that Docker is available, required images are present,
 * and Chart.yaml exists at the configured path.
 *
 * @param pluginConfig Helm plugin configuration.
 * @param context Semantic-release context (logger, cwd, etc).
 * @throws SemanticReleaseError if requirements are missing.
 */
export async function verifyConditions(
  pluginConfig: HelmPluginConfig,
  context: Context,
): Promise<void> {
  const { logger, cwd } = context;

  let dockerOk = true;
  try {
    void runHostCmd('docker version', cwd, logger);
  } catch {
    dockerOk = false;
  }

  if (dockerOk) {
    const helmImage = pluginConfig.helmImage ?? 'alpine/helm:3.15.2';
    const docsImage = pluginConfig.docsImage ?? 'jnorwood/helm-docs:v1.14.2';
    verifyDockerImage(helmImage, logger);
    verifyDockerImage(docsImage, logger);
  } else {
    throw new SemanticReleaseError(
      'Docker not available.',
      'ENODOCKER',
      'Docker must be installed and available on PATH.',
    );
  }

  const chartYamlPath = `${cwd}/${pluginConfig.chartPath}/Chart.yaml`;
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
 * Prepare step: bump chart version, lint and template the chart,
 * run helm-docs, and package into `dist/charts`.
 *
 * @param pluginConfig Helm plugin configuration.
 * @param context Semantic-release context (logger, cwd, nextRelease).
 * @throws SemanticReleaseError if version or Chart.yaml is missing.
 */
export async function prepare(
  pluginConfig: HelmPluginConfig,
  context: Context,
): Promise<void> {
  const { cwd, nextRelease, logger } = context;
  const version = nextRelease?.version;

  if (version === undefined) {
    throw new SemanticReleaseError(
      'Missing next release version.',
      'ENOVERSION',
      'semantic-release did not provide a nextRelease.version.',
    );
  }

  const chartYamlPath = `${cwd}/${pluginConfig.chartPath}/Chart.yaml`;
  if (!fs.existsSync(chartYamlPath)) {
    throw new SemanticReleaseError(
      'Chart.yaml missing during prepare.',
      'EMISSINGCHARTYAML',
      `Expected Chart.yaml in ${pluginConfig.chartPath}.`,
    );
  }

  const raw = fs.readFileSync(chartYamlPath, 'utf8');
  const updatedYaml = setChartVersion(raw, version);
  fs.writeFileSync(chartYamlPath, updatedYaml, 'utf8');
  logger.log(`Updated Chart.yaml to version ${version}`);

  const helmImage = pluginConfig.helmImage ?? 'alpine/helm:3.15.2';
  void runDockerCmd(helmImage, ['lint', pluginConfig.chartPath], cwd, logger);
  void runDockerCmd(
    helmImage,
    ['template', 'sr-check', pluginConfig.chartPath],
    cwd,
    logger,
  );

  const docsImage = pluginConfig.docsImage ?? 'jnorwood/helm-docs:v1.14.2';
  const docsArgs = pluginConfig.docsArgs ?? ['--template-files=README.md'];
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

  const outDir = `${cwd}/dist/charts`;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  void runDockerCmd(
    helmImage,
    ['package', pluginConfig.chartPath, '--destination=dist/charts'],
    cwd,
    logger,
  );
  logger.log('Packaged Helm chart into dist/charts.');
}

/**
 * Extract the `host[:port]` part from an OCI repository URL.
 *
 * @param ociRepo Full OCI repo (e.g. `oci://host:5000/charts/app`).
 * @returns Host and optional port only.
 */
function extractHostPortFromOci(ociRepo: string): string {
  const trimmed = ociRepo.replace(/^oci:\/\//, '');
  const firstSlash = trimmed.indexOf('/');
  return firstSlash === -1 ? trimmed : trimmed.slice(0, firstSlash);
}

/**
 * Publish packaged Helm charts to an OCI registry.
 * Handles insecure registries, credentials, and `helm push`.
 *
 * @param pluginConfig Helm plugin configuration.
 * @param context Semantic-release context (logger, cwd).
 * @throws SemanticReleaseError if no packaged charts exist.
 */
export async function publish(
  pluginConfig: HelmPluginConfig,
  context: Context,
): Promise<void> {
  const { cwd, logger } = context;
  const helmImage = pluginConfig.helmImage ?? 'alpine/helm:3.15.2';

  if (pluginConfig.ociRepo === undefined) {
    logger.log('No OCI repository configured; skipping helm push.');
    return;
  }

  const pkgDir = `${cwd}/dist/charts`;
  const entries = fs.existsSync(pkgDir)
    ? fs.readdirSync(pkgDir, { withFileTypes: true })
    : [];
  const files = entries
    .filter((d) => d.isFile() && d.name.endsWith('.tgz'))
    .map((d) => `dist/charts/${d.name}`);

  if (files.length === 0) {
    throw new SemanticReleaseError(
      'No packaged chart found.',
      'ENOPACKAGEDCHART',
      'Prepare step must package chart before publish.',
    );
  }

  const hostPort = extractHostPortFromOci(pluginConfig.ociRepo);
  const plainHttpFlag = pluginConfig.ociInsecure ? ' --plain-http' : '';
  const insecureLoginFlag = pluginConfig.ociInsecure ? ' --insecure' : '';

  const steps: string[] = [];

  if (pluginConfig.ociInsecure) {
    const cfgJson = `{"auths":{"${hostPort}":{"insecure":true}}}`;
    steps.push(
      'mkdir -p /root/.config/helm/registry',
      `printf %s '${cfgJson}' > /root/.config/helm/registry/config.json`,
    );
  }

  const haveUser = (pluginConfig.ociUsername ?? '').length > 0;
  const havePass = (pluginConfig.ociPassword ?? '').length > 0;
  if (haveUser || havePass || pluginConfig.ociInsecure) {
    const user = haveUser ? pluginConfig.ociUsername : 'anonymous';
    const pass = havePass ? pluginConfig.ociPassword : 'anonymous';
    steps.push(
      `helm registry login${insecureLoginFlag} --username=${user} --password=${pass} ${hostPort}`,
    );
  }

  for (const tgz of files) {
    steps.push(`helm push ${tgz} ${pluginConfig.ociRepo}${plainHttpFlag}`);
  }

  const script = steps.join(' && ');
  runDockerShell(helmImage, script, cwd, logger);

  logger.log(`Pushed ${files.length} chart(s) to ${pluginConfig.ociRepo}`);
}

/**
 * Default export for semantic-release plugin entrypoint.
 */
export default { verifyConditions, prepare, publish };
