import * as fs from 'node:fs';
import SemanticReleaseError from '@semantic-release/error';
import type {
  PrepareContext,
  PublishContext,
  VerifyConditionsContext,
} from 'semantic-release';
import { DockerClient } from './docker.js';
import { GitClient } from './git.js';
import { planGhPages, publishGhPages } from './gh-pages.js';
import { setChartVersion } from './helm-chart.js';
import { HelmClient } from './helm.js';
import { HelmConfig, HelmPluginConfig } from './plugin-config.js';
import { redactCredentials } from './utils/redact.js';

export type { ChartYaml } from './helm-chart.js';

/** Author name for the gh-pages commit when none is configured. */
const COMMIT_NAME = 'semantic-release-bot';
/** Author email for the gh-pages commit when none is configured. */
const COMMIT_EMAIL = 'semantic-release-bot@martynus.net';

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

  const docker = new DockerClient({ logger, cwd });
  await docker.assertAvailable();

  const helmImage = cfg.getHelmImage();
  const docsImage = cfg.getDocsImage();
  logger.log(
    `verifyConditions: helmImage="${helmImage}", docsImage="${docsImage}"`,
  );
  await docker.pull(helmImage);
  await docker.pull(docsImage);

  const chartYamlPath = `${cwd}/${cfg.getChartPath()}/Chart.yaml`;
  if (!fs.existsSync(chartYamlPath)) {
    throw new SemanticReleaseError(
      'Chart.yaml not found.',
      'EMISSINGCHARTYAML',
      `No Chart.yaml found in ${cfg.getChartPath()}.`,
    );
  }
  setChartVersion(
    fs.readFileSync(chartYamlPath, 'utf8'),
    '0.0.0',
    chartYamlPath,
  );
  logger.log(`verifyConditions: found chart at ${chartYamlPath}`);

  if (cfg.isGhEnabled()) {
    const url = cfg.getGhUrl();
    const ghRepo = cfg.getGhRepo();
    logger.log(
      `verifyConditions: GH Pages mode (default). Resolved URL: ` +
        `${url ?? '(none; index will be written without --url)'}`,
    );

    const git = new GitClient({ logger, cwd });
    await git.assertAvailable();
    await git.assertRepository();
    await git.remoteUrl(ghRepo);
    await git.assertReachable(ghRepo);
    logger.log(
      `verifyConditions: remote "${redactCredentials(ghRepo)}" is accessible`,
    );
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

  const docker = new DockerClient({ logger, cwd });
  const helm = new HelmClient({
    docker,
    helmImage: cfg.getHelmImage(),
    docsImage: cfg.getDocsImage(),
    logger,
    cwd,
  });
  await helm.lint(cfg.getChartPath());
  await helm.template(cfg.getChartPath(), cfg.getTemplateValues());

  if (await helm.docs(cfg.getChartPath(), cfg.getDocsArgs())) {
    logger.log('prepare: helm-docs succeeded');
  } else {
    logger.log(
      'prepare: helm-docs failed or missing; skipping docs generation',
    );
  }

  const outDir = `${cwd}/dist/charts`;
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  await helm.package(cfg.getChartPath(), 'dist/charts');
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

  const docker = new DockerClient({ logger, cwd });
  const helm = new HelmClient({
    docker,
    helmImage: cfg.getHelmImage(),
    docsImage: cfg.getDocsImage(),
    logger,
    cwd,
  });
  const git = new GitClient({ logger, cwd });

  const ghPlan = cfg.isGhEnabled()
    ? await planGhPages(git, logger, {
        cwd,
        chartPath: cfg.getChartPath(),
        remote: cfg.getGhRepo(),
        branch: cfg.getGhBranch(),
        repositoryUrl: context.options?.repositoryUrl,
      })
    : undefined;

  if (cfg.isOciEnabled()) {
    const haveUser = cfg.hasOciUser();
    const havePass = cfg.hasOciPass();
    const ociRepo = redactCredentials(cfg.getOciRepo() ?? '');

    logger.log(
      `publish: OCI mode -> repo="${ociRepo}", ` +
        `insecure=${cfg.getOciInsecure()}, ` +
        `usernamePresent=${haveUser}, passwordPresent=${havePass}`,
    );

    await helm.pushToOci({
      hostPort: cfg.getOciHostPort(),
      repo: cfg.getOciRepo() ?? '',
      insecure: cfg.getOciInsecure(),
      username: cfg.getOciUsername(),
      password: cfg.getOciPassword(),
      files,
    });

    logger.log(
      `{ "helm": { "pushed": ${files.length}, "repo": "${ociRepo}" } }`,
    );
  }

  if (ghPlan) {
    await publishGhPages(git, logger, ghPlan, {
      cwd,
      files,
      author: {
        name: process.env.GIT_AUTHOR_NAME || COMMIT_NAME,
        email: process.env.GIT_AUTHOR_EMAIL || COMMIT_EMAIL,
      },
    });

    logger.log(
      '{ "helm": { "published": "gh-pages", "path": "dist/charts", ' +
        '"merged": true } }',
    );
  }

  logger.log('publish: done');
}

// noinspection JSUnusedGlobalSymbols
export default { verifyConditions, prepare, publish } as const;
