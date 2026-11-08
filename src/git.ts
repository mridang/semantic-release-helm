import SemanticReleaseError from '@semantic-release/error';
import { runLogged, type Logger } from './command-runner.js';
import { statusOf } from './utils/error.js';
import { run as execRun, type Runner } from './utils/exec.js';
import { redactCredentials } from './utils/redact.js';

/**
 * Settings of a Git client.
 */
export interface GitOptions {
  /** Receives the command lines and their output. */
  readonly logger: Logger;
  /** Directory the commands run in. */
  readonly cwd: string;
  /** Runs `git`; defaults to the real no-shell runner. Tests inject a fake. */
  readonly run?: Runner;
}

/**
 * Who a commit is attributed to.
 */
export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

/**
 * Everything the plugin does with Git: check that it is usable, inspect
 * remotes, and manage the temporary gh-pages working tree through to the
 * push. Values are passed as separate arguments, never through a shell, and
 * failures are mapped to coded errors here.
 */
export class GitClient {
  private readonly options: GitOptions;

  private readonly runner: Runner;

  /**
   * @param options Logger, directory, and an optional runner.
   */
  constructor(options: GitOptions) {
    this.options = options;
    this.runner = options.run ?? execRun;
  }

  /**
   * Check that git can be started.
   *
   * @throws SemanticReleaseError (`ENOGIT`) when it cannot.
   */
  async assertAvailable(): Promise<void> {
    try {
      await this.exec(['--version']);
    } catch {
      throw new SemanticReleaseError(
        'Git not available for gh-pages publishing.',
        'ENOGIT',
        'Git must be installed and on PATH for gh-pages mode.',
      );
    }
  }

  /**
   * Check that the working directory is inside a git repository.
   *
   * @throws SemanticReleaseError (`ENOTGITREPO`) when it is not.
   */
  async assertRepository(): Promise<void> {
    try {
      await this.exec(['rev-parse', '--git-dir']);
    } catch {
      throw new SemanticReleaseError(
        'Not in a git repository.',
        'ENOTGITREPO',
        'gh-pages mode requires running from within a git repository.',
      );
    }
  }

  /**
   * The URL of a configured remote.
   *
   * @param remote Remote name.
   * @returns The URL, as git prints it.
   * @throws SemanticReleaseError (`ENOREMOTE`) when the remote is not
   *   configured.
   */
  async remoteUrl(remote: string): Promise<string> {
    try {
      return await this.exec(['remote', 'get-url', remote]);
    } catch {
      throw new SemanticReleaseError(
        `Git remote "${redactCredentials(remote)}" not found.`,
        'ENOREMOTE',
        `gh-pages mode requires a configured remote named "${redactCredentials(remote)}".`,
      );
    }
  }

  /**
   * Check that a remote can be reached with the current credentials. Only the
   * exit status is used and the output is discarded, so a remote with a very
   * large number of branches cannot overflow a buffer.
   *
   * @param remote Remote name or URL.
   * @throws SemanticReleaseError (`EREMOTEACCESS`) when it cannot be reached.
   */
  async assertReachable(remote: string): Promise<void> {
    try {
      await this.runner('git', ['ls-remote', '--heads', remote], {
        cwd: this.options.cwd,
      });
    } catch {
      throw new SemanticReleaseError(
        `Cannot access remote repository "${redactCredentials(remote)}".`,
        'EREMOTEACCESS',
        `Check git credentials and network connectivity to ${redactCredentials(remote)}.`,
      );
    }
  }

  /**
   * Remove a working tree, forcibly.
   *
   * @param worktree Path of the working tree.
   * @returns True when git removed it, false when there was nothing to remove.
   */
  async removeWorktree(worktree: string): Promise<boolean> {
    try {
      await this.exec(['worktree', 'remove', worktree, '--force']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch one branch of a remote.
   *
   * @param remote Remote name.
   * @param branch Branch name.
   * @returns True when it was fetched, false when the remote has no such
   *   branch or cannot be reached.
   */
  async fetchBranch(remote: string, branch: string): Promise<boolean> {
    try {
      await this.exec(['fetch', remote, branch]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a working tree for a branch. The remote branch is preferred, then
   * an existing local branch, then a fresh orphan branch.
   *
   * @param worktree Path of the working tree to create.
   * @param remote Remote name.
   * @param branch Branch name.
   */
  async addWorktree(
    worktree: string,
    remote: string,
    branch: string,
  ): Promise<void> {
    if (await this.hasRef(`refs/remotes/${remote}/${branch}`)) {
      await this.exec([
        'worktree',
        'add',
        worktree,
        '-B',
        branch,
        `${remote}/${branch}`,
      ]);
    } else if (await this.hasRef(`refs/heads/${branch}`)) {
      await this.exec(['worktree', 'add', worktree, branch]);
    } else {
      await this.exec(['worktree', 'add', '--detach', worktree]);
      await this.exec(['-C', worktree, 'switch', '--orphan', branch]);
      await this.exec(['-C', worktree, 'reset', '--hard']);
    }
  }

  /**
   * The status of a working tree, as git prints it.
   *
   * @param worktree Path of the working tree.
   * @param allUntracked Whether to list every untracked file.
   * @returns The output.
   */
  async status(worktree: string, allUntracked = false): Promise<string> {
    return this.exec([
      '-C',
      worktree,
      'status',
      ...(allUntracked ? ['--untracked-files=all'] : []),
    ]);
  }

  /**
   * Stage everything in a working tree.
   *
   * @param worktree Path of the working tree.
   */
  async stageAll(worktree: string): Promise<void> {
    await this.exec(['-C', worktree, 'add', '.']);
  }

  /**
   * The summary of what is staged.
   *
   * @param worktree Path of the working tree.
   * @returns The `git diff --staged --stat` output.
   */
  async stagedSummary(worktree: string): Promise<string> {
    return this.exec(['-C', worktree, 'diff', '--staged', '--stat']);
  }

  /**
   * Whether the index of a working tree holds changes that a commit would
   * record. This asks git through its exit status (`git diff --cached
   * --quiet` exits 1 when changes are staged), so it does not depend on the
   * wording of any git message.
   *
   * @param worktree Path of the working tree.
   * @returns True when something is staged.
   * @throws Error when git cannot be run or fails for another reason.
   */
  async hasStagedChanges(worktree: string): Promise<boolean> {
    try {
      await this.runner(
        'git',
        ['-C', worktree, 'diff', '--cached', '--quiet'],
        {
          cwd: this.options.cwd,
        },
      );
      return false;
    } catch (error) {
      if (statusOf(error) === 1) {
        return true;
      }
      throw error;
    }
  }

  /**
   * Commit whatever is staged, or log and do nothing when nothing is staged.
   *
   * @param worktree Path of the working tree.
   * @param message Commit message.
   * @param author Author name and email.
   * @returns True when a commit was created.
   */
  async commitStaged(
    worktree: string,
    message: string,
    author: GitAuthor,
  ): Promise<boolean> {
    if (!(await this.hasStagedChanges(worktree))) {
      this.options.logger.log('gh-pages: no changes to commit');
      return false;
    }
    await this.exec([
      '-C',
      worktree,
      '-c',
      `user.name=${author.name}`,
      '-c',
      `user.email=${author.email}`,
      'commit',
      `--message=${message}`,
    ]);
    return true;
  }

  /**
   * Push a branch from a working tree.
   *
   * @param worktree Path of the working tree.
   * @param remote Remote name.
   * @param branch Branch name.
   */
  async push(worktree: string, remote: string, branch: string): Promise<void> {
    await this.exec(['-C', worktree, 'push', remote, branch]);
  }

  /**
   * Whether a ref exists.
   *
   * @param ref Full ref name.
   * @returns True when it does.
   */
  private async hasRef(ref: string): Promise<boolean> {
    try {
      await this.runner('git', ['show-ref', '--verify', '--quiet', ref], {
        cwd: this.options.cwd,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run git with logging.
   *
   * @param args Arguments after `git`.
   * @returns The trimmed standard output.
   */
  private exec(args: readonly string[]): Promise<string> {
    return runLogged(
      this.runner,
      'git',
      args,
      { cwd: this.options.cwd },
      this.options.logger,
    );
  }
}
