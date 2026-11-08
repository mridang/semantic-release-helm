import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from './command-runner.js';
import type { GitAuthor, GitClient } from './git.js';
import { HelmChart } from './helm-chart.js';
import { HelmIndex } from './helm-index.js';

/**
 * A dotted host name or an IPv4 address. A scp-style remote whose host is
 * anything else (an `~/.ssh/config` alias such as `gh-work`, a Windows drive
 * letter, an IPv6 literal) cannot be vouched for as a web host.
 */
const WEB_HOST =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Turn a git remote URL into the public web base of its repository. scp-style
 * remotes (`git@host:owner/repo`, with or without the user) are recognised
 * first, as git does, then `https://`, `http://`, `ssh://` and `git://`
 * URLs. Credentials are dropped. An `http` or `https` remote keeps its scheme
 * and port; an ssh or git remote becomes `https` on its host name. Nothing is
 * guessed: local paths, `file://` remotes, drive letters, ssh aliases and
 * IPv6 literals yield `undefined`.
 *
 * @param remoteUrl A git remote URL, such as the output of `git remote get-url`.
 * @returns A URL such as `https://github.com/owner/repo`, or undefined when
 *   the remote has no web host that can be derived from it.
 */
export function repositoryWebBase(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  const scp = /^(?:[^@/:]+@)?([^:/@]+):(?!\/\/)(.+)$/.exec(trimmed);
  const parts = scp ? scpParts(scp[1] ?? '', scp[2] ?? '') : urlParts(trimmed);
  if (!parts) {
    return undefined;
  }
  const repoPath = parts.pathname
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '');
  return repoPath.length > 0
    ? `${parts.scheme}//${parts.host}/${repoPath}`
    : undefined;
}

/**
 * The parts of a remote that a web link is built from.
 */
interface RemoteParts {
  readonly scheme: 'http:' | 'https:';
  readonly host: string;
  readonly pathname: string;
}

/**
 * Read an scp-style remote, accepting only a dotted host name.
 *
 * @param host The text before the colon.
 * @param pathname The text after the colon.
 * @returns The parts, or undefined when the host is not a web host.
 */
function scpParts(host: string, pathname: string): RemoteParts | undefined {
  return WEB_HOST.test(host) ? { scheme: 'https:', host, pathname } : undefined;
}

/**
 * Read a URL remote.
 *
 * @param value The remote.
 * @returns The parts, or undefined when it is not an http, https, ssh or git
 *   URL with a host.
 */
function urlParts(value: string): RemoteParts | undefined {
  if (!URL.canParse(value)) {
    return undefined;
  }
  const url = new URL(value);
  const web = url.protocol === 'http:' || url.protocol === 'https:';
  if (!web && url.protocol !== 'ssh:' && url.protocol !== 'git:') {
    return undefined;
  }
  return url.hostname.length > 0
    ? {
        scheme: url.protocol === 'http:' ? 'http:' : 'https:',
        host: web ? url.host : url.hostname,
        pathname: url.pathname,
      }
    : undefined;
}

/**
 * The base for release download links. The release path used by the caller is
 * GitHub's, so a base derived from the remote is used only when that host is
 * github.com or is the host of the repository URL semantic-release was
 * configured with; otherwise the configured repository URL is used, and when
 * neither is usable there is no base.
 *
 * @param remoteUrl The git remote the chart is pushed to.
 * @param repositoryUrl `options.repositoryUrl` from semantic-release, if any.
 * @returns A web base, or undefined when links cannot be built reliably.
 */
export function releaseBase(
  remoteUrl: string,
  repositoryUrl: string | undefined,
): string | undefined {
  const fromRemote = repositoryWebBase(remoteUrl);
  const configured = repositoryWebBase(repositoryUrl ?? '');
  const hostOf = (base: string | undefined): string | undefined =>
    base === undefined ? undefined : new URL(base).hostname;
  return fromRemote !== undefined &&
    (hostOf(fromRemote) === 'github.com' ||
      hostOf(fromRemote) === hostOf(configured))
    ? fromRemote
    : configured;
}

/**
 * Everything the gh-pages publish needs that can be checked before anything
 * irreversible happens: a clean temporary working tree on the gh-pages branch,
 * the existing index (loaded and validated), the chart (parsed) and the base
 * of the release links.
 */
export interface GhPagesPlan {
  readonly remote: string;
  readonly branch: string;
  readonly worktree: string;
  readonly indexPath: string;
  readonly chart: HelmChart;
  readonly releaseBase: string | undefined;
  readonly index: HelmIndex;
}

/**
 * Prepare the gh-pages publish: create the working tree, then load and
 * validate the existing index and the chart. It runs before the OCI push so
 * that a refusal (a malformed index or Chart.yaml) cannot leave a release
 * half published.
 *
 * @param git Git client.
 * @param logger Receives progress messages.
 * @param settings Repository root, chart directory (relative), remote,
 *   branch, and the repository URL semantic-release was configured with.
 * @returns The plan used by the rest of the publish.
 * @throws SemanticReleaseError when the index or Chart.yaml is refused.
 */
export async function planGhPages(
  git: GitClient,
  logger: Logger,
  settings: {
    readonly cwd: string;
    readonly chartPath: string;
    readonly remote: string;
    readonly branch: string;
    readonly repositoryUrl: string | undefined;
  },
): Promise<GhPagesPlan> {
  const { cwd, chartPath, remote, branch, repositoryUrl } = settings;
  const worktree = path.join(cwd, '.gh-pages-tmp');

  if (!(await git.removeWorktree(worktree))) {
    logger.log('gh-pages cleanup: worktree not found (expected)');
  }
  fs.rmSync(worktree, { recursive: true, force: true });

  if (!(await git.fetchBranch(remote, branch))) {
    logger.log('gh-pages: branch does not exist remotely (will create)');
  }
  await git.addWorktree(worktree, remote, branch);
  fs.mkdirSync(worktree, { recursive: true });

  const indexPath = path.join(worktree, 'index.yaml');
  const chart = HelmChart.from(path.join(cwd, chartPath));
  return {
    remote,
    branch,
    worktree,
    indexPath,
    chart,
    releaseBase: releaseBase(await git.remoteUrl(remote), repositoryUrl),
    index: HelmIndex.fromFile(indexPath),
  };
}

/**
 * Add the packaged charts to the index, commit it on the gh-pages branch,
 * push, and remove the temporary working tree.
 *
 * @param git Git client.
 * @param logger Receives progress messages.
 * @param plan The plan made before publishing.
 * @param settings Repository root, the packaged charts (relative to it) and
 *   the commit author.
 */
export async function publishGhPages(
  git: GitClient,
  logger: Logger,
  plan: GhPagesPlan,
  settings: {
    readonly cwd: string;
    readonly files: readonly string[];
    readonly author: GitAuthor;
  },
): Promise<void> {
  const { cwd, files, author } = settings;
  const indexDoc = files.reduce((doc, tgz) => {
    const abs = path.isAbsolute(tgz) ? tgz : path.join(cwd, tgz);
    const filename = path.basename(abs);
    const version = filename.match(/-(\d+\.\d+\.\d+)\.tgz$/)?.[1] || '0.0.0';
    const releaseUrl = plan.releaseBase
      ? `${plan.releaseBase}/releases/download/v${version}/${filename}`
      : filename;

    return doc.append(plan.chart, abs, '', { urls: [releaseUrl] });
  }, plan.index);

  indexDoc.writeTo(plan.indexPath);

  logger.log('gh-pages: running git status before add');
  await git.status(plan.worktree, true);
  await git.stageAll(plan.worktree);
  logger.log('gh-pages: running git status after add');
  await git.status(plan.worktree);
  logger.log('gh-pages: showing staged file diff');
  await git.stagedSummary(plan.worktree);

  await git.commitStaged(
    plan.worktree,
    'docs(charts): update Helm repo (merge index) [skip ci]',
    author,
  );
  await git.push(plan.worktree, plan.remote, plan.branch);

  if (!(await git.removeWorktree(plan.worktree))) {
    logger.log('gh-pages worktree cleanup: already removed');
  }
}
