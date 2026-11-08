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
