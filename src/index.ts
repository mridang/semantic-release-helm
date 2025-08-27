import * as fs from 'fs';
import * as path from 'path';
// @ts-expect-error semantic-release types are not bundled
import { Context, PluginConfig } from 'semantic-release';
// @ts-expect-error semantic-release types are not bundled
import SemanticReleaseError from '@semantic-release/error';
import { execSync } from 'node:child_process';
import * as yaml from 'yaml';
import { HelmIndex } from './helm-index.js';
import { HelmChart } from './helm-chart.js';

export interface HelmPluginConfig extends PluginConfig {
  /**
   * Path to the chart directory that contains Chart.yaml.
   * Example: "charts/app"
   */
  chartPath: string;

  /**
   * OCI repository to push charts to, e.g. "oci://registry.example.com/charts".
   * If omitted, OCI publish is skipped.
   */
  ociRepo?: string;

  /**
   * If true, use plain HTTP / insecure registry behavior for OCI.
   */
  ociInsecure?: boolean;

  /**
   * OCI username (falls back to env OCI_USERNAME).
   */
  ociUsername?: string;

  /**
   * OCI password (falls back to env OCI_PASSWORD).
   */
  ociPassword?: string;

  /**
   * Extra args for helm-docs, default ["--template-files=README.md"].
   */
  docsArgs?: string[];

  /**
   * Docker image for Helm CLI, default "alpine/helm:3.15.2".
   */
  helmImage?: string;

  /**
   * Docker image for helm-docs, default "jnorwood/helm-docs:v1.14.2".
   */
  docsImage?: string;

  /**
   * GitHub Pages configuration. Enabled by default.
   */
  ghPages?: {
    /**
     * Enable/disable gh-pages publish. Default: true.
     */
    enabled?: boolean;
    /**
     * Base URL for the chart repository. If provided, absolute URLs are written
     * into index.yaml. If omitted, relative URLs (file names) are written.
     * Example: "https://example.test/charts"
     */
    url?: string;
    /**
     * Remote name to push to (default "origin").
     */
    repo?: string;
    /**
     * Branch name (default "gh-pages").
     */
    branch?: string;
    /**
     * Subdirectory inside the gh-pages worktree where charts live (default
     * "charts").
     */
    dir?: string;
  };
}

export interface ChartYaml {
  name: string;
  version?: string;
  [key: string]: string | number | boolean | object | undefined;
}

/**
 * Execute a host command and return its trimmed stdout. All interactions are
 * logged to the provided semantic-release logger. If the command produces no
 * stdout, "(no output)" is logged for traceability.
 *
 * On failure, the function:
 * - logs the failing command,
 * - attempts to log captured stdout and stderr from the thrown error object,
 * - rethrows the original error to preserve the exit semantics.
 *
 * The command is executed with stdio "pipe" and UTF-8 decoding so that stdout
 * can be captured and returned to callers. The working directory is set to the
 * repository root (semantic-release's `cwd`).
 *
 * @param cmd Shell command to execute.
 * @param cwd Working directory for the command.
 * @param logger semantic-release logger used for structured logs.
 * @returns Trimmed stdout of the command.
 * @throws Any error thrown by `execSync` is rethrown after being logged.
 */
function runHostCmd(
  cmd: string,
  cwd: string,
  logger: Context['logger'],
): string {
  logger.log(`$ ${cmd}`);
  try {
    const out: string = execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' });
    const trimmed = out.trim();
    logger.log(trimmed.length ? trimmed : '(no output)');
    return trimmed;
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
 * Run a Docker image with the repository mounted at `/apps` and a given set of
 * CLI arguments. This builds a `docker run` invocation with a deterministic
 * host mapping and working directory, then delegates to `runHostCmd`.
 *
 * The container runs to completion and is automatically removed (`--rm`). The
 * function's purpose is to provide a small, audited surface for running Helm
 * and related tooling in a clean environment.
 *
 * @param image Docker image name, including tag.
 * @param args Arguments appended after the image in `docker run`.
 * @param cwd Host working directory, mounted to `/apps` in the container.
 * @param logger semantic-release logger used for structured logs.
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
 * Run a shell script inside a Docker container. This composes a `docker run`
 * command that sets `/bin/sh -lc <script>` as entrypoint, uses `/apps` as the
 * working directory, and mounts the repo as in `runDockerCmd`.
 *
 * The script is JSON-encoded to avoid quoting pitfalls on the host shell. The
 * function returns only after the container exits.
 *
 * @param image Docker image name, including tag.
 * @param script A POSIX shell one-liner to execute via `/bin/sh -lc`.
 * @param cwd Host working directory, mounted to `/apps` in the container.
 * @param logger semantic-release logger used for structured logs.
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
 * Pull a Docker image to ensure availability at runtime. On failure, this
 * converts the underlying error into a `SemanticReleaseError` so the failure
 * is reported with a stable code (`EIMAGEPULLFAILED`).
 *
 * @param image Docker image to pull.
 * @param logger semantic-release logger used for structured logs.
 * @throws SemanticReleaseError if the image cannot be pulled.
 */
function verifyDockerImage(image: string, logger: Context['logger']): void {
  const cmd = `docker pull ${image}`;
  logger.log(`$ ${cmd}`);
  try {
    const out: string = execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
    const trimmed = out.trim();
    logger.log(trimmed.length ? trimmed : '(no output)');
  } catch (err: unknown) {
    throw new SemanticReleaseError(
      `Failed to pull Docker image: ${image}`,
      'EIMAGEPULLFAILED',
      err instanceof Error ? err.message : 'Unknown error',
    );
  }
}

/**
 * Return a new Chart.yaml string with only the `version` field updated. The
 * function parses the input YAML, shallow-copies the object to avoid losing
 * unknown fields, overrides `version`, and stringifies the result.
 *
 * @param rawYaml Raw Chart.yaml content.
 * @param version Version string to set.
 * @returns Updated YAML string.
 */
function setChartVersion(rawYaml: string, version: string): string {
  const parsed: ChartYaml = yaml.parse(rawYaml) as ChartYaml;
  const updated: ChartYaml = { ...parsed, version };
  return yaml.stringify(updated);
}

/**
 * From an `oci://` URL, extract the `host[:port]` component. This is used to
 * prepare login and insecure-registry configuration for Helm Registry v2.
 *
 * @param ociRepo Repository URL, e.g. `oci://ghcr.io/org/charts`.
 * @returns Host, possibly with an explicit port.
 */
function extractHostPortFromOci(ociRepo: string): string {
  const trimmed = ociRepo.replace(/^oci:\/\//, '');
  const i = trimmed.indexOf('/');
  return i === -1 ? trimmed : trimmed.slice(0, i);
}

/**
 * Resolve OCI credentials from plugin config or environment. When present,
 * boolean flags indicate whether a username or password was supplied so that
 * callers can validate completeness before attempting a login.
 *
 * @param cfg Helm plugin configuration.
 * @returns Resolved username/password and presence flags.
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
 * semantic-release `verifyConditions` step. Verifies that:
 * - Docker is available,
 * - required Docker images can be pulled,
 * - the Chart.yaml exists at the configured path,
 * - OCI configuration is coherent if provided.
 *
 * The method logs the effective Helm/docs images, reports whether GH Pages
 * mode is enabled and the resolved public URL, and rejects incomplete OCI
 * credentials early with a stable error code.
 *
 * @param pluginConfig Plugin configuration supplied by semantic-release.
 * @param context semantic-release context (logger, cwd, etc).
 * @throws SemanticReleaseError when a precondition is not satisfied.
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
      'Docker must be installed and on PATH.',
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

  const ghEnabled = pluginConfig.ghPages?.enabled !== false;
  if (ghEnabled) {
    const url = pluginConfig.ghPages?.url;
    logger.log(
      `verifyConditions: GH Pages mode (default). Resolved URL: ${
        url ?? '(none; index will be written without --url)'
      }`,
    );
  }

  const ociRepo = pluginConfig.ociRepo;
  if (ociRepo) {
    const { haveUser, havePass } = resolveCreds(pluginConfig);
    logger.log(
      `verifyConditions: OCI enabled -> repo="${ociRepo}", ` +
        `insecure=${pluginConfig.ociInsecure === true}, ` +
        `usernamePresent=${haveUser}, passwordPresent=${havePass}`,
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
 * semantic-release `prepare` step. Performs all changes that must be included
 * in the release commit before publishing:
 * - sets the chart version in Chart.yaml to `nextRelease.version`,
 * - lints and templates the chart with Helm to fail early on errors,
 * - runs `helm-docs` in the chart directory (best-effort),
 * - packages the chart into `dist/charts/*.tgz`.
 *
 * The function intentionally does not create `index.yaml` in `dist/charts` so
 * tests can assert that merge logic occurs only during the gh-pages publish
 * step.
 *
 * @param pluginConfig Plugin configuration supplied by semantic-release.
 * @param context semantic-release context (cwd, logger, nextRelease).
 * @throws SemanticReleaseError if required inputs are missing or invalid.
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
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  void runDockerCmd(
    helmImage,
    ['package', pluginConfig.chartPath, '--destination=dist/charts'],
    cwd,
    logger,
  );
  logger.log('prepare: packaged chart(s) into dist/charts');

  logger.log('prepare: ok');
}

/**
 * semantic-release `publish` step. Publishes the packaged chart(s) to:
 * - an OCI registry (optional), and/or
 * - a GitHub Pages branch (default).
 *
 * OCI publish:
 * - optionally writes an insecure registry config for Helm if requested,
 * - performs a `helm registry login` when credentials are supplied,
 * - pushes each packaged `*.tgz` to the configured `ociRepo`.
 *
 * GitHub Pages publish:
 * - cleans any prior temporary worktree,
 * - fetches the remote branch and creates the worktree from:
 *   1) the remote branch when available,
 *   2) otherwise an existing local branch,
 *   3) otherwise a fresh orphan branch,
 * - copies `*.tgz` into the configured subdirectory,
 * - merges `index.yaml` in pure YAML to preserve history across charts,
 * - commits and pushes changes to the gh-pages branch,
 * - removes the temporary worktree.
 *
 * The remote-first worktree creation avoids non-fast-forward push failures when
 * a remote `gh-pages` already exists with history.
 *
 * @param pluginConfig Plugin configuration supplied by semantic-release.
 * @param context semantic-release context (cwd, logger).
 * @throws SemanticReleaseError if no packaged charts are present.
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

  if (pluginConfig.ociRepo) {
    const helmImage = pluginConfig.helmImage ?? 'alpine/helm:3.15.2';
    const hostPort = extractHostPortFromOci(pluginConfig.ociRepo);
    const plainHttpFlag = pluginConfig.ociInsecure ? ' --plain-http' : '';
    const insecureLoginFlag = pluginConfig.ociInsecure ? ' --insecure' : '';
    const { username, password, haveUser, havePass } =
      resolveCreds(pluginConfig);

    logger.log(
      `publish: OCI mode -> repo="${pluginConfig.ociRepo}", ` +
        `insecure=${pluginConfig.ociInsecure === true}, ` +
        `usernamePresent=${haveUser}, passwordPresent=${havePass}`,
    );

    const steps: string[] = [];
    if (pluginConfig.ociInsecure) {
      const cfgJson = `{"auths":{"${hostPort}":{"insecure":true}}}`;
      steps.push(
        'mkdir -p /root/.config/helm/registry',
        `printf %s '${cfgJson}' > /root/.config/helm/registry/config.json`,
      );
    }
    if (haveUser && havePass) {
      steps.push(
        `helm registry login${insecureLoginFlag} ` +
          `--username=${username} --password=${password} ${hostPort}`,
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

  const ghEnabled = pluginConfig.ghPages?.enabled !== false;
  if (ghEnabled) {
    const ghCfg = pluginConfig.ghPages ?? {};
    const ghBranch = ghCfg.branch ?? 'gh-pages';
    const ghRepo = ghCfg.repo ?? 'origin';
    const ghDir = ghCfg.dir ?? 'charts';
    const baseUrl = ghCfg.url;

    const tmpWorktree = path.join(cwd, '.gh-pages-tmp');
    const srcDir = path.join(cwd, 'dist', 'charts');
    const dstDir = path.join(tmpWorktree, ghDir);

    try {
      runHostCmd(
        `git worktree remove "${tmpWorktree}" --force || ` +
          `echo "gh-pages cleanup: not a worktree"`,
        cwd,
        logger,
      );
    } catch {
      // ignore
    }
    runHostCmd(`rm -rf "${tmpWorktree}"`, cwd, logger);

    const refCheck = `git show-ref --verify --quiet "refs/heads/${ghBranch}"`;
    const addExisting = `git worktree add "${tmpWorktree}" ${ghBranch}`;
    const addOrphan = [
      `git worktree add --detach "${tmpWorktree}"`,
      `git -C "${tmpWorktree}" switch --orphan ${ghBranch}`,
      `git -C "${tmpWorktree}" reset --hard`,
    ].join(' && ');

    runHostCmd(`git fetch ${ghRepo} ${ghBranch} || true`, cwd, logger);
    const refRemoteCheck = `git show-ref --verify --quiet "refs/remotes/${ghRepo}/${ghBranch}"`;
    const addFromRemote =
      `git worktree add "${tmpWorktree}" -B ${ghBranch} ` +
      `${ghRepo}/${ghBranch}`;

    runHostCmd(
      `${refRemoteCheck} && (${addFromRemote}) || ` +
        `(${refCheck} && (${addExisting}) || (${addOrphan}))`,
      cwd,
      logger,
    );

    fs.mkdirSync(dstDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir)) {
      if (entry.endsWith('.tgz')) {
        const from = path.join(srcDir, entry);
        const to = path.join(dstDir, entry);
        fs.copyFileSync(from, to);
      }
    }

    const indexPath = path.join(dstDir, 'index.yaml');
    let indexDoc = HelmIndex.fromFile(indexPath);

    const chart = HelmChart.from(path.join(cwd, pluginConfig.chartPath));
    for (const tgz of files) {
      const abs = path.isAbsolute(tgz) ? tgz : path.join(cwd, tgz);
      const filename = path.basename(abs);
      const extra =
        typeof baseUrl === 'string' && baseUrl.trim().length > 0
          ? undefined
          : { urls: [filename] as string[] };

      indexDoc = indexDoc.append(
        chart,
        abs,
        typeof baseUrl === 'string' ? baseUrl : '',
        extra,
      );
    }

    indexDoc.writeTo(indexPath);

    runHostCmd(`git -C "${tmpWorktree}" add .`, cwd, logger);
    runHostCmd(
      `git -C "${tmpWorktree}" commit -m ` +
        `"docs(charts): update Helm repo (merge index) [skip ci]" ` +
        `|| echo "No changes"`,
      cwd,
      logger,
    );
    runHostCmd(
      `git -C "${tmpWorktree}" push ${ghRepo} ${ghBranch}`,
      cwd,
      logger,
    );

    try {
      runHostCmd(
        `git worktree remove "${tmpWorktree}" --force || ` +
          `echo "gh-pages worktree already removed or not a working tree"`,
        cwd,
        logger,
      );
    } catch {
      // ignore
    }

    logger.log(
      '{ "helm": { "published": "gh-pages", "path": "dist/charts", ' +
        '"merged": true } }',
    );
  }

  logger.log('publish: done');
}

export default { verifyConditions, prepare, publish };
