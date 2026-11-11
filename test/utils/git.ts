import { execFileAsync } from './exec.js';

/**
 * Run git in a directory and return its output, for building fixtures.
 * @param cwd - Directory to run in.
 * @param args - Arguments after `git`.
 * @returns The standard output.
 */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  return stdout;
}

/**
 * Initialise a repository with a committer identity.
 * @param dir - Directory to initialise.
 */
export async function initRepo(dir: string): Promise<void> {
  await git(dir, 'init', '--quiet');
  await git(dir, 'config', 'user.name', 'init');
  await git(dir, 'config', 'user.email', 'init@example.test');
}
