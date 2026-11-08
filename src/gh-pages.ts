import { spawnSync } from 'node:child_process';
import { runHostCmd } from './command-runner.js';
import { quoteWord } from './docker/cli-client.js';
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
 * Turn a git remote URL into the public web base of its repository, for
 * building release download links. Credentials in the URL (`user:token@`)
 * and the port are dropped, and `https://`, `ssh://`, `git://` and
 * scp-style (`git@host:owner/repo`) remotes are understood, so a token can
 * never reach a published index.
 *
 * @param remoteUrl Output of `git remote get-url`.
 * @returns A URL such as `https://github.com/owner/repo`.
 */
export function repositoryWebBase(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  const scp = /^(?:[^@/:]+@)?([^:/@]+):(?!\/\/)(.+)$/.exec(trimmed);
  const { host, pathname } = URL.canParse(trimmed)
    ? { host: new URL(trimmed).hostname, pathname: new URL(trimmed).pathname }
    : { host: scp?.[1] ?? '', pathname: scp?.[2] ?? trimmed };
  const repoPath = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  return `https://${host || 'github.com'}/${repoPath}`;
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
