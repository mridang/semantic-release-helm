import * as fs from 'fs';
// @ts-expect-error semantic-release types are not bundled
import { Context, PluginConfig } from 'semantic-release';
// @ts-expect-error semantic-release types are not bundled
import SemanticReleaseError from '@semantic-release/error';
import { execSync } from 'node:child_process';
import * as yaml from 'yaml';

export interface HelmPluginConfig extends PluginConfig {
  chartPath: string;
  ociRepo?: string;
  ociInsecure?: boolean;
  ociUsername?: string;
  ociPassword?: string;
  docsArgs?: string[];
  helmImage?: string;
  docsImage?: string;
  ghPages?: {
    enabled?: boolean;
    url?: string;
  };
}

export interface ChartYaml {
  name: string;
  version?: string;
  [key: string]: string | number | boolean | object | undefined;
}

/**
 * Run a host command and capture output. Throws on non-zero exit.
 */
function runHostCmd(
  cmd: string,
  cwd: string,
  logger: Context['logger'],
): string {
  logger.log(`$ ${cmd}`);
  try {
    const out: string = execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' });
    logger.log(out.trim().length ? out.trim() : '(no output)');
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
      if (out.trim()) logger.error(out.trim());
      if (errOut.trim()) logger.error(errOut.trim());
      if (e.message) logger.error(e.message);
    }
    throw err;
  }
}

/**
 * Run a Dockerized CLI with the project mounted to /apps.
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
 * Run a shell script inside the container.
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
 * Pull a Docker image and fail fast if unavailable.
 */
function verifyDockerImage(image: string, logger: Context['logger']): void {
  const cmd = `docker pull ${image}`;
  logger.log(`$ ${cmd}`);
  try {
    const out: string = execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
    logger.log(out.trim().length ? out.trim() : '(no output)');
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
 * Update version within Chart.yaml while preserving other keys.
 */
function setChartVersion(rawYaml: string, version: string): string {
  const parsed: ChartYaml = yaml.parse(rawYaml) as ChartYaml;
  const updated: ChartYaml = { ...parsed, version };
  return yaml.stringify(updated);
}

/**
 * Extract host[:port] from an oci:// URL.
 */
function extractHostPortFromOci(ociRepo: string): string {
  const trimmed = ociRepo.replace(/^oci:\/\//, '');
  const i = trimmed.indexOf('/');
  return i === -1 ? trimmed : trimmed.slice(0, i);
}

/**
 * Resolve credentials from config or env.
 */
function resolveCreds(cfg: HelmPluginConfig): {
  username?: string;
  password?: string;
  haveUser: boolean;
  havePass: boolean;
} {
  const username = cfg.ociUsername ?? process.env.OCI_USERNAME;
  const password = cfg.ociPassword ?? process.env.OCI_PASSWORD;
  return { username, password, haveUser: !!username, havePass: !!password };
}

/**
 * Verify environment and prerequisites for this plugin.
 *
 * - Ensures Docker is usable.
 * - Pulls required images.
 * - Checks Chart.yaml exists.
 * - Logs which publish mode will run (GH Pages default vs OCI).
 * - Validates credential shape when provided.
 */
export async function verifyConditions(
  pluginConfig: HelmPluginConfig,
  context: Context,
): Promise<void> {
  const { logger, cwd } = context;
  logger.log('verifyConditions: starting');

  try {
    void runHostCmd('docker version', cwd, logger);
  } catch {
    throw new SemanticReleaseError(
      'Docker not available.',
      'ENODOCKER',
      'Docker must be installed and available on PATH.',
    );
  }

  const helmImage = pluginConfig.helmImage ?? 'alpine/helm:3.15.2';
  const docsImage = pluginConfig.docsImage ?? 'jnorwood/helm-docs:v1.14.2';
  logger.log(
    `verifyConditions: helmImage="${helmImage}", docsImage="${docsImage}"`,
  );

  verifyDockerImage(helmImage, logger);
  verifyDockerImage(docsImage, logger);

  const chartYamlPath = `${cwd}/${pluginConfig.chartPath}/Chart.yaml`;
  if (!fs.existsSync(chartYamlPath)) {
    throw new SemanticReleaseError(
      'Chart.yaml not found.',
      'EMISSINGCHARTYAML',
      `No Chart.yaml found in ${pluginConfig.chartPath}.`,
    );
  }
  logger.log(`verifyConditions: found chart at ${chartYamlPath}`);

  const ociRepo = pluginConfig.ociRepo;
  if (!ociRepo) {
    const url = pluginConfig.ghPages?.url;
    if (url) {
      logger.log(
        `verifyConditions: GH Pages mode (default). Resolved URL: ${url}`,
      );
    } else {
      logger.log(
        'verifyConditions: GH Pages mode (default). Resolved URL: (none; index will be written without --url)',
      );
    }
  } else {
    const { haveUser, havePass } = resolveCreds(pluginConfig);
    logger.log(
      `verifyConditions: OCI mode -> repo="${ociRepo}", insecure=${pluginConfig.ociInsecure === true}, usernamePresent=${haveUser}, passwordPresent=${havePass}`,
    );
    if ((haveUser && !havePass) || (!haveUser && havePass)) {
      throw new SemanticReleaseError(
        'Incomplete OCI credentials.',
        'EOCICREDSINCOMPLETE',
        'Provide both username and password, or neither.',
      );
    }
  }

  logger.log('verifyConditions: ok');
}

/**
 * Prepare: bump chart version, lint/template, run helm-docs, package, and build GH Pages index.
 */
export async function prepare(
  pluginConfig: HelmPluginConfig,
  context: Context,
): Promise<void> {
  const { cwd, nextRelease, logger } = context;
  logger.log('prepare: starting');

  const version = nextRelease?.version;
  if (!version) {
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
  logger.log(`prepare: updated Chart.yaml to version ${version}`);

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
    logger.log('prepare: helm-docs succeeded');
  } catch {
    logger.log(
      'prepare: helm-docs failed or missing; skipping docs generation',
    );
  }

  const outDir = `${cwd}/dist/charts`;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  void runDockerCmd(
    helmImage,
    ['package', pluginConfig.chartPath, '--destination=dist/charts'],
    cwd,
    logger,
  );
  logger.log('prepare: packaged chart(s) into dist/charts');

  // GH Pages index (default)
  if (!pluginConfig.ociRepo) {
    const url = pluginConfig.ghPages?.url;
    const indexArgs = url
      ? ['repo', 'index', 'dist/charts', `--url=${url}`]
      : ['repo', 'index', 'dist/charts'];
    void runDockerCmd(helmImage, indexArgs, cwd, logger);
    logger.log('prepare: generated dist/charts/index.yaml');
  }

  logger.log('prepare: ok');
}

/**
 * Publish: if OCI is configured, push tarballs to the registry.
 * GH Pages mode is "prepare-only" (files are ready in dist/charts).
 */
export async function publish(
  pluginConfig: HelmPluginConfig,
  context: Context,
): Promise<void> {
  const { cwd, logger } = context;
  logger.log('publish: starting');

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
  logger.log(`publish: found ${files.length} packaged chart(s)`);

  if (!pluginConfig.ociRepo) {
    logger.log(
      'publish: GH Pages mode; nothing to push (artifact upload left to CI)',
    );
    return;
  }

  const helmImage = pluginConfig.helmImage ?? 'alpine/helm:3.15.2';
  const hostPort = extractHostPortFromOci(pluginConfig.ociRepo);
  const plainHttpFlag = pluginConfig.ociInsecure ? ' --plain-http' : '';
  const insecureLoginFlag = pluginConfig.ociInsecure ? ' --insecure' : '';

  const { username, password, haveUser, havePass } = resolveCreds(pluginConfig);

  logger.log(
    `publish: OCI mode -> repo="${pluginConfig.ociRepo}", insecure=${pluginConfig.ociInsecure === true}, usernamePresent=${haveUser}, passwordPresent=${havePass}`,
  );

  const steps: string[] = [];

  if (pluginConfig.ociInsecure) {
    const cfgJson = `{"auths":{"${hostPort}":{"insecure":true}}}`;
    steps.push(
      'mkdir -p /root/.config/helm/registry',
      `printf %s '${cfgJson}' > /root/.config/helm/registry/config.json`,
    );
  }

  // Only log in if we actually have credentials.
  if (haveUser && havePass) {
    steps.push(
      `helm registry login${insecureLoginFlag} --username=${username} --password=${password} ${hostPort}`,
    );
  }

  for (const tgz of files) {
    steps.push(`helm push ${tgz} ${pluginConfig.ociRepo}${plainHttpFlag}`);
  }

  const script = steps.join(' && ');
  runDockerShell(helmImage, script, cwd, logger);

  logger.log(
    `{ "helm": { "pushed": ${files.length}, "repo": "${pluginConfig.ociRepo}" } }`,
  );
}

// noinspection JSUnusedGlobalSymbols
export default { verifyConditions, prepare, publish };
