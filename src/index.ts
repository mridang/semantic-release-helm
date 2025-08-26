// file: src/index.ts
import * as fs from 'fs';
// @ts-expect-error since this is not typed
import { Context, PluginConfig } from 'semantic-release';
// @ts-expect-error since this is not typed
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
}

export interface ChartYaml {
  name: string;
  version?: string;
  [key: string]: string | number | boolean | object | undefined;
}

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

function runDockerShell(
  image: string,
  script: string,
  cwd: string,
  logger: Context['logger'],
): void {
  const full: string = [
    'docker run --rm',
    '--add-host=host.docker.internal:host-gateway',
    `-v ${cwd}:/apps`,
    '-w /apps',
    '--entrypoint',
    '/bin/sh',
    image,
    '-lc',
    JSON.stringify(script),
  ].join(' ');
  void runHostCmd(full, cwd, logger);
}

function verifyDockerImage(image: string, logger: Context['logger']): void {
  const cmd: string = `docker pull ${image}`;
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

function setChartVersion(rawYaml: string, version: string): string {
  const parsed: ChartYaml = yaml.parse(rawYaml) as ChartYaml;
  const updated: ChartYaml = { ...parsed, version };
  return yaml.stringify(updated);
}

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

export async function prepare(
  pluginConfig: HelmPluginConfig,
  context: Context,
): Promise<void> {
  const { cwd, nextRelease, logger } = context;
  const version: string | undefined = nextRelease?.version;

  if (version === undefined) {
    throw new SemanticReleaseError(
      'Missing next release version.',
      'ENOVERSION',
      'semantic-release did not provide a nextRelease.version.',
    );
  }

  const chartYamlPath: string = `${cwd}/${pluginConfig.chartPath}/Chart.yaml`;
  if (!fs.existsSync(chartYamlPath)) {
    throw new SemanticReleaseError(
      'Chart.yaml missing during prepare.',
      'EMISSINGCHARTYAML',
      `Expected Chart.yaml in ${pluginConfig.chartPath}.`,
    );
  }

  const raw: string = fs.readFileSync(chartYamlPath, 'utf8');
  const updatedYaml: string = setChartVersion(raw, version);
  fs.writeFileSync(chartYamlPath, updatedYaml, 'utf8');
  logger.log(`Updated Chart.yaml to version ${version}`);

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
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  void runDockerCmd(
    helmImage,
    ['package', pluginConfig.chartPath, '-d', 'dist/charts'],
    cwd,
    logger,
  );
  logger.log('Packaged Helm chart into dist/charts.');
}

function extractHostPortFromOci(ociRepo: string): string {
  const trimmed: string = ociRepo.replace(/^oci:\/\//, '');
  const firstSlash: number = trimmed.indexOf('/');
  return firstSlash === -1 ? trimmed : trimmed.slice(0, firstSlash);
}

export async function publish(
  pluginConfig: HelmPluginConfig,
  context: Context,
): Promise<void> {
  const { cwd, logger } = context;
  const helmImage: string = pluginConfig.helmImage ?? 'alpine/helm:3.15.2';

  if (pluginConfig.ociRepo === undefined) {
    logger.log('No OCI repository configured; skipping helm push.');
    return;
  }

  const pkgDir: string = `${cwd}/dist/charts`;
  const entries = fs.existsSync(pkgDir)
    ? fs.readdirSync(pkgDir, { withFileTypes: true })
    : [];
  const files: string[] = entries
    .filter((d) => d.isFile() && d.name.endsWith('.tgz'))
    .map((d) => `dist/charts/${d.name}`);

  if (files.length === 0) {
    throw new SemanticReleaseError(
      'No packaged chart found.',
      'ENOPACKAGEDCHART',
      'Prepare step must package chart before publish.',
    );
  }

  const hostPort: string = extractHostPortFromOci(pluginConfig.ociRepo);
  const plainHttpFlag = pluginConfig.ociInsecure ? ' --plain-http' : '';
  const insecureLoginFlag = pluginConfig.ociInsecure ? ' --insecure' : '';

  // Build a single script to run inside the Helm image
  const steps: string[] = [];

  if (pluginConfig.ociInsecure) {
    // Mark the host as insecure in Helm's registry config (helps some envs)
    const cfgJson: string = `{"auths":{"${hostPort}":{"insecure":true}}}`;
    steps.push(
      'mkdir -p /root/.config/helm/registry',
      `printf %s '${cfgJson}' > /root/.config/helm/registry/config.json`,
    );
  }

  // Always do a non-interactive login if creds provided, or if insecure, use anon
  if (
    (pluginConfig.ociUsername ?? '').length > 0 ||
    (pluginConfig.ociPassword ?? '').length > 0 ||
    pluginConfig.ociInsecure
  ) {
    const user =
      (pluginConfig.ociUsername ?? '').length > 0
        ? pluginConfig.ociUsername
        : 'anonymous';
    const pass =
      (pluginConfig.ociPassword ?? '').length > 0
        ? pluginConfig.ociPassword
        : 'anonymous';
    steps.push(
      `helm registry login${insecureLoginFlag} -u ${user} -p ${pass} ${hostPort}`,
    );
  }

  for (const tgz of files) {
    // >>> KEY FIX: add --plain-http when pushing to an HTTP registry
    steps.push(`helm push ${tgz} ${pluginConfig.ociRepo}${plainHttpFlag}`);
  }

  const script = steps.join(' && ');
  runDockerShell(helmImage, script, cwd, logger);

  logger.log(`Pushed ${files.length} chart(s) to ${pluginConfig.ociRepo}`);
}

export default { verifyConditions, prepare, publish };
