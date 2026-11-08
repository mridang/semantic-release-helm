import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import SemanticReleaseError from '@semantic-release/error';
import type {
  PrepareContext,
  PublishContext,
  VerifyConditionsContext,
} from 'semantic-release';
import { HelmIndex } from './helm-index.js';
import { HelmChart, setChartVersion } from './helm-chart.js';
import { DockerCliClient } from './docker/cli-client.js';
import { redactCredentials } from './utils/redact.js';
import { quoteWord } from './utils/shell.js';
import type { Logger } from './docker/client.js';
import { DockerImage } from './docker/image.js';
import { runHostCmd } from './command-runner.js';
import {
  HelmConfig,
  HelmPluginConfig,
  templateSetArgs,
} from './plugin-config.js';
import { DockerHelmDocs } from './helm-docs.js';
import {
  buildWorktreeAddCommand,
  commitIfStaged,
  repositoryWebBase,
} from './gh-pages.js';
import { buildOciPublish } from './oci-publish.js';

/**
 * Minimal shape of a Chart.yaml document.
 */
export interface ChartYaml {
  name: string;
  version?: string;
  [key: string]: string | number | boolean | object | undefined;
}

const COMMIT_NAME = 'semantic-release-bot';
const COMMIT_EMAIL = 'semantic-release-bot@martynus.net';

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
  args: readonly string[],
  cwd: string,
  logger: Logger,
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
 * @param env Variables passed to the container by name, for secrets.
 */
async function runDockerShell(
  image: string,
  script: string,
  cwd: string,
  logger: Logger,
  env?: Readonly<Record<string, string>>,
): Promise<void> {
  const img = new DockerImage(image, cwd, logger, new DockerCliClient());
  await img.shell(script, env);
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
async function verifyDockerImage(image: string, logger: Logger): Promise<void> {
  await new DockerCliClient().pull(image, logger);
}

/**
 * semantic-release `verifyConditions` step. Verifies that:
 * - Docker is available,
 * - required Docker images can be pulled,
 * - the Chart.yaml exists at the configured path,
 * - OCI configuration is coherent if provided.
 * - Git configuration and gh-pages access is valid if enabled.
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
  context: VerifyConditionsContext,
): Promise<void> {
  const { logger } = context;
  const cwd = context.cwd ?? process.cwd();
  const cfg = new HelmConfig(pluginConfig);

  logger.log('verifyConditions: starting');

  try {
    runHostCmd('docker version', cwd, logger);
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
    const ghRepo = cfg.getGhRepo();
    logger.log(
      `verifyConditions: GH Pages mode (default). Resolved URL: ` +
        `${url ?? '(none; index will be written without --url)'}`,
    );

    try {
      runHostCmd('git --version', cwd, logger);
    } catch {
      throw new SemanticReleaseError(
        'Git not available for gh-pages publishing.',
        'ENOGIT',
        'Git must be installed and on PATH for gh-pages mode.',
      );
    }

    try {
      runHostCmd('git rev-parse --git-dir', cwd, logger);
    } catch {
      throw new SemanticReleaseError(
        'Not in a git repository.',
        'ENOTGITREPO',
        'gh-pages mode requires running from within a git repository.',
      );
    }

    try {
      runHostCmd(`git remote get-url ${quoteWord(ghRepo)}`, cwd, logger);
    } catch {
      throw new SemanticReleaseError(
        `Git remote "${redactCredentials(ghRepo)}" not found.`,
        'ENOREMOTE',
        `gh-pages mode requires a configured remote named "${redactCredentials(ghRepo)}".`,
      );
    }

    try {
      runHostCmd(`git ls-remote --heads ${quoteWord(ghRepo)}`, cwd, logger);
      logger.log(
        `verifyConditions: remote "${redactCredentials(ghRepo)}" is accessible`,
      );
    } catch {
      throw new SemanticReleaseError(
        `Cannot access remote repository "${redactCredentials(ghRepo)}".`,
        'EREMOTEACCESS',
        `Check git credentials and network connectivity to ${redactCredentials(ghRepo)}.`,
      );
    }
  }

  if (cfg.isOciEnabled()) {
    const haveUser = cfg.hasOciUser();
    const havePass = cfg.hasOciPass();
    logger.log(
      `verifyConditions: OCI enabled -> repo="${redactCredentials(cfg.getOciRepo() ?? '')}", ` +
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
  context: PrepareContext,
): Promise<void> {
  const { nextRelease, logger } = context;
  const cwd = context.cwd ?? process.cwd();
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
  const updatedYaml = setChartVersion(raw, version, chartYamlPath);
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
      ...templateSetArgs(cfg.getTemplateValues()),
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
  context: PublishContext,
): Promise<void> {
  const { logger } = context;
  const cwd = context.cwd ?? process.cwd();
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
    const haveUser = cfg.hasOciUser();
    const havePass = cfg.hasOciPass();

    logger.log(
      `publish: OCI mode -> repo="${redactCredentials(cfg.getOciRepo() ?? '')}", ` +
        `insecure=${cfg.getOciInsecure()}, ` +
        `usernamePresent=${haveUser}, passwordPresent=${havePass}`,
    );

    const { script, env } = buildOciPublish({
      hostPort: cfg.getOciHostPort(),
      repo: cfg.getOciRepo(),
      insecure: cfg.getOciInsecure(),
      username: cfg.getOciUsername(),
      password: cfg.getOciPassword(),
      files,
    });
    await runDockerShell(helmImage, script, cwd, logger, env);

    logger.log(
      `{ "helm": { "pushed": ${files.length}, "repo": "${redactCredentials(cfg.getOciRepo() ?? '')}" } }`,
    );
  }

  if (cfg.isGhEnabled()) {
    const ghBranch = cfg.getGhBranch();
    const ghRepo = cfg.getGhRepo();

    const tmpWorktree = path.join(cwd, '.gh-pages-tmp');

    try {
      runHostCmd(
        `git worktree remove ${quoteWord(tmpWorktree)} --force`,
        cwd,
        logger,
      );
    } catch {
      logger.log('gh-pages cleanup: worktree not found (expected)');
    }
    fs.rmSync(tmpWorktree, { recursive: true, force: true });

    try {
      runHostCmd(
        `git fetch ${quoteWord(ghRepo)} ${quoteWord(ghBranch)}`,
        cwd,
        logger,
      );
    } catch {
      logger.log('gh-pages: branch does not exist remotely (will create)');
    }

    runHostCmd(
      buildWorktreeAddCommand(tmpWorktree, ghRepo, ghBranch),
      cwd,
      logger,
    );

    fs.mkdirSync(tmpWorktree, { recursive: true });

    const indexPath = path.join(tmpWorktree, 'index.yaml');
    const chart = HelmChart.from(path.join(cwd, cfg.getChartPath()));

    const remoteUrl = execSync(`git remote get-url ${quoteWord(ghRepo)}`, {
      cwd,
      encoding: 'utf8',
    }).trim();
    const repoBase =
      repositoryWebBase(remoteUrl) ??
      repositoryWebBase(context.options?.repositoryUrl ?? '');

    const indexDoc = files.reduce((doc, tgz) => {
      const abs = path.isAbsolute(tgz) ? tgz : path.join(cwd, tgz);
      const filename = path.basename(abs);
      const version = filename.match(/-(\d+\.\d+\.\d+)\.tgz$/)?.[1] || '0.0.0';
      const releaseUrl = repoBase
        ? `${repoBase}/releases/download/v${version}/${filename}`
        : filename;

      return doc.append(chart, abs, '', { urls: [releaseUrl] });
    }, HelmIndex.fromFile(indexPath));

    indexDoc.writeTo(indexPath);

    logger.log('gh-pages: running git status before add');
    runHostCmd(
      `git -C ${quoteWord(tmpWorktree)} status --untracked-files=all`,
      cwd,
      logger,
    );

    runHostCmd(`git -C ${quoteWord(tmpWorktree)} add .`, cwd, logger);

    logger.log('gh-pages: running git status after add');
    runHostCmd(`git -C ${quoteWord(tmpWorktree)} status`, cwd, logger);
    logger.log('gh-pages: showing staged file diff');
    runHostCmd(
      `git -C ${quoteWord(tmpWorktree)} diff --staged --stat`,
      cwd,
      logger,
    );

    const gitAuthorName = process.env.GIT_AUTHOR_NAME || COMMIT_NAME;
    const gitAuthorEmail = process.env.GIT_AUTHOR_EMAIL || COMMIT_EMAIL;

    commitIfStaged(
      tmpWorktree,
      cwd,
      'docs(charts): update Helm repo (merge index) [skip ci]',
      { name: gitAuthorName, email: gitAuthorEmail },
      logger,
    );

    runHostCmd(
      `git -C ${quoteWord(tmpWorktree)} push ${quoteWord(ghRepo)} ${quoteWord(ghBranch)}`,
      cwd,
      logger,
    );

    try {
      runHostCmd(
        `git worktree remove ${quoteWord(tmpWorktree)} --force`,
        cwd,
        logger,
      );
    } catch {
      logger.log('gh-pages worktree cleanup: already removed');
    }

    logger.log(
      '{ "helm": { "published": "gh-pages", "path": "dist/charts", ' +
        '"merged": true } }',
    );
  }

  logger.log('publish: done');
}

// noinspection JSUnusedGlobalSymbols
export default { verifyConditions, prepare, publish } as const;
