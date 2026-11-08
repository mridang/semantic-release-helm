import { spawnSync } from 'node:child_process';
import { runHostCmd } from './command-runner.js';
import { quoteWord } from './utils/shell.js';
import type { Logger } from './docker/client.js';

/**
 * Whether the index of a git working tree holds changes that a commit would
 * record. This asks git through its exit status (`git diff --cached --quiet`
 * exits 1 when changes are staged), so it does not depend on the wording of
 * any git message.
 *
 * @param worktree Path of the working tree.
 * @returns True when something is staged.
 * @throws Error when git cannot be run or fails for another reason.
 */
export function hasStagedChanges(worktree: string): boolean {
  const result = spawnSync('git', [
    '-C',
    worktree,
    'diff',
    '--cached',
    '--quiet',
  ]);
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    return false;
  }
  if (result.status === 1) {
    return true;
  }
  throw new Error(
    `git diff --cached failed with status ${result.status}: ${result.stderr.toString('utf8').trim()}`,
  );
}

/**
 * Commit whatever is staged in a working tree, or log and do nothing when
 * nothing is staged. Author values are shell-quoted.
 *
 * @param worktree Path of the working tree.
 * @param cwd Directory the commands run in.
 * @param message Commit message.
 * @param author Author name and email.
 * @param logger Logger for the commands and the skip notice.
 * @returns True when a commit was created.
 */
export function commitIfStaged(
  worktree: string,
  cwd: string,
  message: string,
  author: { readonly name: string; readonly email: string },
  logger: Logger,
): boolean {
  if (!hasStagedChanges(worktree)) {
    logger.log('gh-pages: no changes to commit');
    return false;
  }
  runHostCmd(
    `git -C ${quoteWord(worktree)} -c ${quoteWord(`user.name=${author.name}`)} -c ${quoteWord(`user.email=${author.email}`)} commit ${quoteWord(`--message=${message}`)}`,
    cwd,
    logger,
  );
  return true;
}

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
 * Build the shell command that creates the temporary gh-pages working tree.
 * It prefers the remote branch, then an existing local branch, then a fresh
 * orphan branch. Every dynamic value is shell-quoted.
 *
 * @param worktree Path of the working tree to create.
 * @param remote Git remote name.
 * @param branch Branch name.
 * @returns A command line for `sh`.
 */
export function buildWorktreeAddCommand(
  worktree: string,
  remote: string,
  branch: string,
): string {
  const wt = quoteWord(worktree);
  const br = quoteWord(branch);
  const refRemoteCheck = `git show-ref --verify --quiet ${quoteWord(`refs/remotes/${remote}/${branch}`)}`;
  const addFromRemote = `git worktree add ${wt} -B ${br} ${quoteWord(`${remote}/${branch}`)}`;
  const refCheck = `git show-ref --verify --quiet ${quoteWord(`refs/heads/${branch}`)}`;
  const addExisting = `git worktree add ${wt} ${br}`;
  const addOrphan = [
    `git worktree add --detach ${wt}`,
    `git -C ${wt} switch --orphan ${br}`,
    `git -C ${wt} reset --hard`,
  ].join(' && ');
  return (
    `${refRemoteCheck} && (${addFromRemote}) || ` +
    `(${refCheck} && (${addExisting}) || (${addOrphan}))`
  );
}
