import { execFileSync } from 'node:child_process';

/**
 * Run git in a directory and return its output, for building fixtures.
 * @param cwd - Directory to run in.
 * @param args - Arguments after `git`.
 * @returns The standard output.
 */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Initialise a repository with a committer identity.
 * @param dir - Directory to initialise.
 */
export function initRepo(dir: string): void {
  git(dir, 'init', '--quiet');
  git(dir, 'config', 'user.name', 'init');
  git(dir, 'config', 'user.email', 'init@example.test');
}
