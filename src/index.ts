import * as fs from 'node:fs';
import SemanticReleaseError from '@semantic-release/error';
import type {
  PrepareContext,
  PublishContext,
  VerifyConditionsContext,
} from 'semantic-release';
import { Chart } from './chart.js';
import { ChartPackage } from './chart-package.js';
import { assertDockerAvailable, DockerImage } from './docker.js';
import {
  abandonGhPages,
  planGhPages,
  publishGhPages,
  verifyGhPages,
} from './gh-pages.js';
import { OciRegistry } from './oci-registry.js';
import { HelmConfig, HelmPluginConfig } from './plugin-config.js';
import { redactCredentials } from './utils/redact.js';

export type { ChartYaml } from './chart.js';

/** Author name for the gh-pages commit when none is configured. */
const COMMIT_NAME = 'semantic-release-bot';
/** Author email for the gh-pages commit when none is configured. */
const COMMIT_EMAIL = 'semantic-release-bot@martynus.net';

/**
 * The Helm and helm-docs images, and the chart, for a configuration.
 *
 * @param cfg Plugin configuration.
 * @param context The step's logger and directory.
 * @returns The two images.
 */
function imagesOf(
  cfg: HelmConfig,
  context: { readonly logger: PublishContext['logger']; readonly cwd: string },
): { readonly helm: DockerImage; readonly docs: DockerImage } {
  return {
    helm: new DockerImage({ ...context, image: cfg.getHelmImage() }),
    docs: new DockerImage({ ...context, image: cfg.getDocsImage() }),
  };
}

/**
 * Open the configured chart.
 *
 * @param cfg Plugin configuration.
 * @param context The step's logger and directory.
 * @returns The chart.
 */
function chartOf(
  cfg: HelmConfig,
  context: { readonly logger: PublishContext['logger']; readonly cwd: string },
): Chart {
  return Chart.open({
    ...context,
    directory: cfg.getChartPath(),
    ...imagesOf(cfg, context),
  });
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
  const here = { logger, cwd };

  logger.log('verifyConditions: starting');

  await assertDockerAvailable(here);

  const images = imagesOf(cfg, here);
  logger.log(
    `verifyConditions: helmImage="${images.helm.reference}", docsImage="${images.docs.reference}"`,
  );
  await images.helm.pull();
  await images.docs.pull();

  const chartYamlPath = `${cwd}/${cfg.getChartPath()}/Chart.yaml`;
  if (!Chart.exists({ cwd, directory: cfg.getChartPath() })) {
    throw new SemanticReleaseError(
      'Chart.yaml not found.',
      'EMISSINGCHARTYAML',
      `No Chart.yaml found in ${cfg.getChartPath()}.`,
    );
  }
  chartOf(cfg, here).withVersion('0.0.0');
  logger.log(`verifyConditions: found chart at ${chartYamlPath}`);

  if (cfg.isGhEnabled()) {
    const url = cfg.getGhUrl();
    logger.log(
      `verifyConditions: GH Pages mode (default). Resolved URL: ` +
        `${url ?? '(none; index will be written without --url)'}`,
    );
    await verifyGhPages(here, cfg.getGhRepo());
    logger.log(
      `verifyConditions: remote "${redactCredentials(cfg.getGhRepo())}" is accessible`,
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
    if (haveUser !== havePass) {
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
  const here = { logger, cwd };

  logger.log('prepare: starting');

  const version = nextRelease?.version;
  if (!version) {
    throw new SemanticReleaseError(
      'Missing next release version.',
      'ENOVERSION',
      'semantic-release did not provide a nextRelease.version.',
    );
  }

  if (!Chart.exists({ cwd, directory: cfg.getChartPath() })) {
    throw new SemanticReleaseError(
      'Chart.yaml missing during prepare.',
      'EMISSINGCHARTYAML',
      `Expected Chart.yaml in ${cfg.getChartPath()}.`,
    );
  }

  const chart = chartOf(cfg, here).withVersion(version).save();
  logger.log(`prepare: updated Chart.yaml to version ${version}`);

  await chart.lint();
  await chart.render(cfg.getTemplateValues());
  await chart.document(cfg.getDocsArgs());

  const outDir = `${cwd}/dist/charts`;
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  await chart.package('dist/charts');
  logger.log('prepare: packaged chart(s) into dist/charts');

  logger.log('prepare: ok');
}

/**
 * Push the packages to the configured OCI registry, one after the other.
 *
 * @param cfg Plugin configuration.
 * @param context The step's logger and directory.
 * @param packages The packages to push.
 */
async function publishToOci(
  cfg: HelmConfig,
  context: { readonly logger: PublishContext['logger']; readonly cwd: string },
  packages: readonly ChartPackage[],
): Promise<void> {
  const { logger, cwd } = context;
  const ociRepo = redactCredentials(cfg.getOciRepo() ?? '');
  logger.log(
    `publish: OCI mode -> repo="${ociRepo}", ` +
      `insecure=${cfg.getOciInsecure()}, ` +
      `usernamePresent=${cfg.hasOciUser()}, passwordPresent=${cfg.hasOciPass()}`,
  );

  const registry = new OciRegistry({
    repo: cfg.getOciRepo() ?? '',
    hostPort: cfg.getOciHostPort(),
    insecure: cfg.getOciInsecure(),
    username: cfg.getOciUsername(),
    password: cfg.getOciPassword(),
    helm: imagesOf(cfg, context).helm,
    cwd,
  });
  for (const pkg of packages) {
    const published = await registry.publish(pkg);
    if (published.digest !== undefined) {
      logger.log(`publish: pushed ${pkg.fileName} as ${published.digest}`);
    }
  }

  logger.log(
    `{ "helm": { "pushed": ${packages.length}, "repo": "${ociRepo}" } }`,
  );
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
  const here = { logger, cwd };

  logger.log('publish: starting');

  const found = ChartPackage.find(`${cwd}/dist/charts`);
  if (found.length === 0) {
    throw new SemanticReleaseError(
      'No packaged chart found.',
      'ENOPACKAGEDCHART',
      'Prepare step must package chart before publish.',
    );
  }

  const chart = cfg.isGhEnabled() ? chartOf(cfg, here) : undefined;
  const packages = chart ? chart.select(found) : found;
  if (packages.length === 0) {
    throw new SemanticReleaseError(
      'No packaged chart found.',
      'ENOPACKAGEDCHART',
      `Prepare step must package ${chart?.name()} ${chart?.version()} before publish.`,
    );
  }
  logger.log(`publish: found ${packages.length} packaged chart(s)`);
  if (packages.length < found.length) {
    logger.log(
      `publish: ignoring ${found.length - packages.length} packaged chart(s) of other versions`,
    );
  }

  const ghPlan = chart
    ? await planGhPages(here, {
        chart,
        remote: cfg.getGhRepo(),
        branch: cfg.getGhBranch(),
        url: cfg.getGhUrl(),
        repositoryUrl: context.options?.repositoryUrl,
      })
    : undefined;

  try {
    if (cfg.isOciEnabled()) {
      await publishToOci(cfg, here, packages);
    }
    if (ghPlan) {
      await publishGhPages(here, ghPlan, {
        packages,
        tag: context.nextRelease?.gitTag,
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
  } catch (error) {
    if (ghPlan) {
      await abandonGhPages(ghPlan);
    }
    throw error;
  }

  logger.log('publish: done');
}

// noinspection JSUnusedGlobalSymbols
export default { verifyConditions, prepare, publish } as const;
