import { runLogged, type CommandContext } from './command-runner.js';
import type { Branch } from './remote.js';
import { statusOf } from './utils/error.js';
import { run as execRun } from './utils/exec.js';

/**
 * Who a commit is attributed to.
 */
export interface Author {
  /** Author name. */
  readonly name: string;
  /** Author email. */
  readonly email: string;
}

/**
 * A commit that was created.
 */
export interface Commit {
  /** The commit hash. */
  readonly sha: string;
  /** The commit message. */
  readonly message: string;
}

/**
 * One path with changes in a working tree: its two-letter porcelain status
 * and the path.
 */
export interface Change {
  /** Porcelain status, such as `M` or `??`. */
  readonly status: string;
  /** Path relative to the working tree. */
  readonly path: string;
}

/**
 * Settings of a working tree handle.
 */
export interface WorktreeOptions extends CommandContext {
  /** Directory of the working tree. */
  readonly directory: string;
  /** The branch checked out in it. */
  readonly branch: Branch;
}

/**
 * A git working tree with a branch checked out. It lists its changes, commits
 * them, and can be removed.
 */
export class Worktree {
  private readonly options: WorktreeOptions;

  /**
   * @param options Directory, branch, logger, base directory and runner.
   */
  constructor(options: WorktreeOptions) {
    this.options = options;
  }

  /**
   * The directory of the working tree.
   *
   * @returns The path.
   */
  get directory(): string {
    return this.options.directory;
  }

  /**
   * The branch checked out here, with this directory attached so a push runs
   * from the right place.
   *
   * @returns The branch.
   */
  get branch(): Branch {
    return { ...this.options.branch, directory: this.options.directory };
  }

  /**
   * The paths with changes, untracked files included.
   *
   * @returns The changes, in the order git lists them.
   */
  async changes(): Promise<readonly Change[]> {
    const output = await this.git([
      '-C',
      this.options.directory,
      'status',
      '--porcelain',
      '--untracked-files=all',
    ]);
    return output
      .split('\n')
      .filter((line) => line.length > 3)
      .map((line) => ({
        status: line.slice(0, 2).trim(),
        path: line.slice(3),
      }));
  }

  /**
   * Stage everything and commit it. Whether anything is staged is decided
   * from git's exit status, not from the wording of any message.
   *
   * @param message Commit message.
   * @param author Author name and email.
   * @returns The commit, or undefined when there was nothing to commit.
   */
  async commit(message: string, author: Author): Promise<Commit | undefined> {
    const dir = this.options.directory;
    await this.git(['-C', dir, 'add', '.']);
    const pending = await this.changes();
    this.options.logger.log(`git: ${pending.length} path(s) changed`);
    if (!(await this.hasStagedChanges())) {
      this.options.logger.log('gh-pages: no changes to commit');
      return undefined;
    }
    await this.git([
      '-C',
      dir,
      '-c',
      `user.name=${author.name}`,
      '-c',
      `user.email=${author.email}`,
      'commit',
      `--message=${message}`,
    ]);
    const sha = await this.git(['-C', dir, 'rev-parse', 'HEAD']);
    return { sha, message };
  }

  /**
   * Remove the working tree, forcibly.
   *
   * @returns True when git removed it, false when there was nothing to remove.
   */
  async remove(): Promise<boolean> {
    try {
      await this.git(['worktree', 'remove', this.options.directory, '--force']);
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Whether the index holds changes that a commit would record
   * (`git diff --cached --quiet` exits 1 when it does).
   *
   * @returns True when something is staged.
   * @throws Error when git fails for another reason.
   */
  private async hasStagedChanges(): Promise<boolean> {
    try {
      await (this.options.run ?? execRun)(
        'git',
        ['-C', this.options.directory, 'diff', '--cached', '--quiet'],
        { cwd: this.options.cwd },
      );
    } catch (error) {
      if (statusOf(error) === 1) {
        return true;
      }
      throw error;
    }
    return false;
  }

  /**
   * Run git with logging.
   *
   * @param args Arguments after `git`.
   * @returns The trimmed standard output.
   */
  private git(args: readonly string[]): Promise<string> {
    return runLogged(
      this.options.run ?? execRun,
      'git',
      args,
      { cwd: this.options.cwd },
      this.options.logger,
    );
  }
}
