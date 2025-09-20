import * as fs from 'fs';
import * as path from 'path';
// @ts-expect-error semantic-release types are not bundled
import { Context } from 'semantic-release';
// @ts-expect-error semantic-release types are not bundled
import SemanticReleaseError from '@semantic-release/error';
import * as yaml from 'yaml';
import { HelmIndex } from './helm-index.js';
import { HelmChart } from './helm-chart.js';
import { DockerCliClient } from './docker/cli-client.js';
import { DockerImage } from './docker/image.js';
import { runHostCmd } from './command-runner.js';
import { HelmPluginConfig, HelmConfig } from './plugin-config.js';
import { DockerHelmDocs } from './helm-docs.js';

export interface ChartYaml {
  name: string;
  version?: string;
  [key: string]: string | number | boolean | object | undefined;
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
async function runDockerCmd(
  image: string,
  args: string[],
  cwd: string,
  logger: Context['logger'],
): Promise<void> {
  const img = new DockerImage(image, cwd, logger, new DockerCliClient());
  await img.run(args);
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
async function runDockerShell(
  image: string,
  script: string,
  cwd: string,
  logger: Context['logger'],
): Promise<void> {
  const img = new DockerImage(image, cwd, logger, new DockerCliClient());
  await img.shell(script);
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
async function verifyDockerImage(
  image: string,
  logger: Context['logger'],
): Promise<void> {
  const client = new DockerCliClient();
  try {
    await client.pull(image, logger);
  } catch (err: unknown) {
    if (err instanceof SemanticReleaseError) {
      throw err;
    }
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
  const cfg = new HelmConfig(pluginConfig);

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

  const helmImage = cfg.getHelmImage();
  const docsImage = cfg.getDocsImage();
  logger.log(
    `verifyConditions: helmImage="${helmImage}", docsImage="${docsImage}"`,
  );
  await verifyDockerImage(helmImage, logger);
  await verifyDockerImage(docsImage, logger);

  const chartYamlPath = `${cwd}/${cfg.getChartPath()}/Chart.yaml`;
  if (!fs.existsSync(chartYamlPath)) {
    throw new SemanticReleaseError(
      'Chart.yaml not found.',
      'EMISSINGCHARTYAML',
      `No Chart.yaml found in ${cfg.getChartPath()}.`,
    );
  }
  logger.log(`verifyConditions: found chart at ${chartYamlPath}`);

  if (cfg.isGhEnabled()) {
    const url = cfg.getGhUrl();
    logger.log(
      `verifyConditions: GH Pages mode (default). Resolved URL: ` +
        `${url ?? '(none; index will be written without --url)'}`,
    );
  }

  if (cfg.isOciEnabled()) {
    const haveUser = cfg.hasOciUser();
    const havePass = cfg.hasOciPass();
    logger.log(
      `verifyConditions: OCI enabled -> repo="${cfg.getOciRepo()}", ` +
        `insecure=${cfg.getOciInsecure()}, ` +
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
 * - normalizes README markers back to the Go template call, then runs helm-docs,
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
  const cfg = new HelmConfig(pluginConfig);

  logger.log('prepare: starting');

  const version = nextRelease?.version;
  if (!version) {
    throw new SemanticReleaseError(
      'Missing next release version.',
      'ENOVERSION',
      'semantic-release did not provide a nextRelease.version.',
    );
  }

  const chartYamlPath = `${cwd}/${cfg.getChartPath()}/Chart.yaml`;
  if (!fs.existsSync(chartYamlPath)) {
    throw new SemanticReleaseError(
      'Chart.yaml missing during prepare.',
      'EMISSINGCHARTYAML',
      `Expected Chart.yaml in ${cfg.getChartPath()}.`,
    );
  }

  const raw = fs.readFileSync(chartYamlPath, 'utf8');
  const updatedYaml = setChartVersion(raw, version);
  fs.writeFileSync(chartYamlPath, updatedYaml, 'utf8');
  logger.log(`prepare: updated Chart.yaml to version ${version}`);

  const helmImage = cfg.getHelmImage();
  await runDockerCmd(helmImage, ['lint', cfg.getChartPath()], cwd, logger);
  await runDockerCmd(
    helmImage,
    [
      'template',
      'sr-check',
      cfg.getChartPath(),
      ...(() => {
        const templateValues = cfg.getTemplateValues();
        if (!templateValues) {
          return [];
        }

        const flattenObject = (
          obj: Record<string, unknown>,
          prefix = '',
        ): Record<string, string> =>
          Object.keys(obj).reduce((acc: Record<string, string>, k: string) => {
            const pre = prefix.length ? `${prefix}.` : '';
            const value = obj[k];
            if (
              typeof value === 'object' &&
              value !== null &&
              !Array.isArray(value)
            ) {
              Object.assign(
                acc,
                flattenObject(value as Record<string, unknown>, pre + k),
              );
            } else {
              acc[pre + k] = String(value);
            }
            return acc;
          }, {});

        return Object.entries(flattenObject(templateValues)).flatMap(
          ([key, value]) => ['--set', `${key}=${value}`],
        );
      })(),
    ],
    cwd,
    logger,
  );

  const helmDocs = new DockerHelmDocs({ image: cfg.getDocsImage() });
  try {
    await helmDocs.generate(cwd, cfg.getChartPath(), cfg.getDocsArgs(), logger);
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
  await runDockerCmd(
    helmImage,
    ['package', cfg.getChartPath(), '--destination=dist/charts'],
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
  const cfg = new HelmConfig(pluginConfig);

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

  if (cfg.isOciEnabled()) {
    const helmImage = cfg.getHelmImage();
    const hostPort = cfg.getOciHostPort();
    const plainHttpFlag = cfg.getOciPlainHttpFlag();
    const insecureLoginFlag = cfg.getOciInsecureLoginFlag();
    const username = cfg.getOciUsername();
    const password = cfg.getOciPassword();
    const haveUser = cfg.hasOciUser();
    const havePass = cfg.hasOciPass();

    logger.log(
      `publish: OCI mode -> repo="${cfg.getOciRepo()}", ` +
        `insecure=${cfg.getOciInsecure()}, ` +
        `usernamePresent=${haveUser}, passwordPresent=${havePass}`,
    );

    const steps: string[] = [];
    if (cfg.getOciInsecure() && hostPort) {
      const cfgJson = `{"auths":{"${hostPort}":{"insecure":true}}}`;
      steps.push(
        'mkdir -p /root/.config/helm/registry',
        `printf %s '${cfgJson}' > /root/.config/helm/registry/config.json`,
      );
    }
    if (haveUser && havePass && hostPort) {
      steps.push(
        `helm registry login${insecureLoginFlag} ` +
          `--username=${username} --password=${password} ${hostPort}`,
      );
    }

    for (const tgz of files) {
      steps.push(`helm push ${tgz} ${cfg.getOciRepo()}${plainHttpFlag}`);
    }

    const script = steps.join(' && ');
    await runDockerShell(helmImage, script, cwd, logger);

    logger.log(
      `{ "helm": { "pushed": ${files.length}, "repo": "${cfg.getOciRepo()}" } }`,
    );
  }

  if (cfg.isGhEnabled()) {
    const ghBranch = cfg.getGhBranch();
    const ghRepo = cfg.getGhRepo();
    const ghDir = cfg.getGhDir();
    const baseUrl = cfg.getGhUrl();

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
    const refRemoteCheck =
      `git show-ref --verify --quiet ` + `"refs/remotes/${ghRepo}/${ghBranch}"`;
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

    const chart = HelmChart.from(path.join(cwd, cfg.getChartPath()));
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

    logger.log('gh-pages: running git status before add');
    runHostCmd(
      `git -C "${tmpWorktree}" status --untracked-files=all`,
      cwd,
      logger,
    );

    runHostCmd(`git -C "${tmpWorktree}" add .`, cwd, logger);

    logger.log('gh-pages: running git status after add');
    runHostCmd(`git -C "${tmpWorktree}" status`, cwd, logger);
    logger.log('gh-pages: showing staged file diff');
    runHostCmd(`git -C "${tmpWorktree}" diff --staged --stat`, cwd, logger);

    runHostCmd(
      `git -C "${tmpWorktree}" commit -m ` +
        `"docs(charts): update Helm repo (merge index) [skip ci]" ` +
        `|| echo "No changes"`,
      cwd,
      logger,
    );

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
      //
    }

    logger.log(
      '{ "helm": { "published": "gh-pages", "path": "dist/charts", ' +
        '"merged": true } }',
    );
  }

  logger.log('publish: done');
}

// noinspection JSUnusedGlobalSymbols
export default { verifyConditions, prepare, publish };
