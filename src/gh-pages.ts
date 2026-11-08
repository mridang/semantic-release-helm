import * as fs from 'node:fs';
import * as path from 'node:path';
import SemanticReleaseError from '@semantic-release/error';
import type { Chart } from './chart.js';
import type { ChartPackage } from './chart-package.js';
import { ChartRepository } from './chart-repository.js';
import type { CommandContext } from './command-runner.js';
import { GitRepository } from './git-repository.js';
import type { Remote } from './remote.js';
import { RemoteUrl } from './remote-url.js';
import type { Author, Worktree } from './worktree.js';
import { redactCredentials } from './utils/redact.js';

/**
 * Check that gh-pages publishing can work: git is usable, the directory is a
 * repository, the remote exists and can be reached.
 *
 * @param context Logger, directory and runner.
 * @param remoteName Name of the remote the branch is pushed to.
 * @returns The remote, once it is known to be reachable.
 * @throws SemanticReleaseError (`ENOGIT`, `ENOTGITREPO`, `ENOREMOTE` or
 *   `EREMOTEACCESS`) for the first thing that is wrong.
 */
export async function verifyGhPages(
  context: CommandContext,
  remoteName: string,
): Promise<Remote> {
  const repository = await GitRepository.open(context);
  const remote = await repository.remote(remoteName);
  if (!(await remote.isReachable())) {
    throw new SemanticReleaseError(
      `Cannot access remote repository "${redactCredentials(remoteName)}".`,
      'EREMOTEACCESS',
      `Check git credentials and network connectivity to ${redactCredentials(remoteName)}.`,
    );
  }
  return remote;
}

/**
 * Everything the gh-pages publish needs that can be checked before anything
 * irreversible happens: a clean temporary working tree on the gh-pages
 * branch, the existing chart repository (loaded and validated) and the base
 * of the release links.
 */
export interface GhPagesPlan {
  readonly remote: Remote;
  readonly worktree: Worktree;
  readonly repository: ChartRepository;
  readonly chart: Chart;
  readonly releaseBase: string | undefined;
}

/**
 * Prepare the gh-pages publish: create the working tree, then load and
 * validate the existing chart repository. It runs before the OCI push so
 * that a refusal (a malformed index) cannot leave a release half published.
 *
 * @param context Logger, directory and runner for git.
 * @param settings The chart, remote and branch names, and the repository URL
 *   semantic-release was configured with.
 * @returns The plan used by the rest of the publish.
 * @throws SemanticReleaseError when the index is refused.
 */
export async function planGhPages(
  context: CommandContext,
  settings: {
    readonly chart: Chart;
    readonly remote: string;
    readonly branch: string;
    readonly repositoryUrl: string | undefined;
  },
): Promise<GhPagesPlan> {
  const { chart, branch, repositoryUrl } = settings;
  const repository = await GitRepository.open(context);
  const remote = await repository.remote(settings.remote);
  const directory = path.join(context.cwd, '.gh-pages-tmp');

  if (!(await repository.removeWorktree(directory))) {
    context.logger.log('gh-pages cleanup: worktree not found (expected)');
  }
  fs.rmSync(directory, { recursive: true, force: true });

  const fetched = await remote.fetch(branch);
  if (fetched === undefined) {
    context.logger.log(
      'gh-pages: branch does not exist remotely (will create)',
    );
  }
  const worktree = await repository.createWorktree(
    directory,
    branch,
    fetched ?? { name: branch, remote: remote.name },
  );
  fs.mkdirSync(directory, { recursive: true });

  const configured = repositoryUrl ? RemoteUrl.parse(repositoryUrl) : undefined;
  return {
    remote,
    worktree,
    repository: ChartRepository.open(directory),
    chart,
    releaseBase: remote.url.releaseBase(configured),
  };
}

/**
 * Add the packaged charts to the chart repository, commit it on the gh-pages
 * branch, push, and remove the temporary working tree.
 *
 * @param context Logger for the progress messages.
 * @param plan The plan made before publishing.
 * @param settings The packages to add and the commit author.
 */
export async function publishGhPages(
  context: CommandContext,
  plan: GhPagesPlan,
  settings: {
    readonly packages: readonly ChartPackage[];
    readonly author: Author;
  },
): Promise<void> {
  const repository = settings.packages.reduce((current, pkg) => {
    if (plan.releaseBase === undefined) {
      return current.add(plan.chart, pkg, '', { urls: [pkg.fileName] });
    }
    const url = `${plan.releaseBase}/releases/download/v${pkg.version}/${pkg.fileName}`;
    return current.add(plan.chart, pkg, '', { urls: [url] });
  }, plan.repository);
  repository.save();

  await plan.worktree.commit(
    'docs(charts): update Helm repo (merge index) [skip ci]',
    settings.author,
  );
  await plan.remote.push(plan.worktree.branch);

  if (!(await plan.worktree.remove())) {
    context.logger.log('gh-pages worktree cleanup: already removed');
  }
}
