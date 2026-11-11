import SemanticReleaseError from '@semantic-release/error';
import { runLogged, type CommandContext } from './command-runner.js';
import { Remote, type Branch } from './remote.js';
import { RemoteUrl } from './remote-url.js';
import { Worktree } from './worktree.js';
import { run as execRun } from './utils/exec.js';
import { redactCredentials } from './utils/redact.js';

/**
 * A git repository on disk. It hands out its remotes and working trees.
 */
export class GitRepository {
  private readonly context: CommandContext;

  /**
   * @param context - Logger, directory and runner.
   */
  private constructor(context: CommandContext) {
    this.context = context;
  }

  /**
   * Open the repository the context's directory is inside.
   * @param context - Logger, directory and runner.
   * @returns The repository.
   * @throws SemanticReleaseError (`ENOGIT`) when git cannot be started, or
   *   (`ENOTGITREPO`) when the directory is not in a repository.
   */
  static async open(context: CommandContext): Promise<GitRepository> {
    const repository = new GitRepository(context);
    try {
      await repository.git(['--version']);
    } catch {
      throw new SemanticReleaseError(
        'Git not available for gh-pages publishing.',
        'ENOGIT',
        'Git must be installed and on PATH for gh-pages mode.',
      );
    }
    try {
      await repository.git(['rev-parse', '--git-dir']);
    } catch {
      throw new SemanticReleaseError(
        'Not in a git repository.',
        'ENOTGITREPO',
        'gh-pages mode requires running from within a git repository.',
      );
    }
    return repository;
  }

  /**
   * A configured remote.
   * @param name - Remote name.
   * @returns The remote.
   * @throws SemanticReleaseError (`ENOREMOTE`) when it is not configured.
   */
  async remote(name: string): Promise<Remote> {
    const url = await this.git(['remote', 'get-url', name]).then(
      (text): string | undefined => text,
      (): string | undefined => undefined,
    );
    if (url === undefined) {
      throw new SemanticReleaseError(
        `Git remote "${redactCredentials(name)}" not found.`,
        'ENOREMOTE',
        `gh-pages mode requires a configured remote named "${redactCredentials(name)}".`,
      );
    }
    return new Remote({ ...this.context, name, url: RemoteUrl.parse(url) });
  }

  /**
   * Create a working tree for a branch. The given remote branch is preferred
   * when its remote-tracking ref exists, then an existing local branch, then
   * a fresh orphan branch.
   * @param directory - Path of the working tree to create.
   * @param name - Branch name.
   * @param from - The remote branch to start from, if any.
   * @returns The working tree.
   */
  async createWorktree(
    directory: string,
    name: string,
    from?: Branch,
  ): Promise<Worktree> {
    if (
      from?.remote !== undefined &&
      (await this.hasRef(`refs/remotes/${from.remote}/${name}`))
    ) {
      await this.git([
        'worktree',
        'add',
        directory,
        '-B',
        name,
        `${from.remote}/${name}`,
      ]);
      return new Worktree({ ...this.context, directory, branch: { name } });
    }
    if (await this.hasRef(`refs/heads/${name}`)) {
      await this.git(['worktree', 'add', directory, name]);
      return new Worktree({ ...this.context, directory, branch: { name } });
    }
    await this.git(['worktree', 'add', '--detach', directory]);
    await this.git(['-C', directory, 'switch', '--orphan', name]);
    await this.git(['-C', directory, 'reset', '--hard']);
    return new Worktree({ ...this.context, directory, branch: { name } });
  }

  /**
   * Remove a working tree that may be left over from an earlier run.
   * @param directory - Path of the working tree.
   * @returns True when git removed it, false when there was nothing to remove.
   */
  async removeWorktree(directory: string): Promise<boolean> {
    return new Worktree({
      ...this.context,
      directory,
      branch: { name: '' },
    }).remove();
  }

  /**
   * Whether a ref exists.
   * @param ref - Full ref name.
   * @returns True when it does.
   */
  private async hasRef(ref: string): Promise<boolean> {
    try {
      await (this.context.run ?? execRun)(
        'git',
        ['show-ref', '--verify', '--quiet', ref],
        { cwd: this.context.cwd },
      );
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Run git with logging.
   * @param args - Arguments after `git`.
   * @returns The trimmed standard output.
   */
  private git(args: readonly string[]): Promise<string> {
    return runLogged(
      this.context.run ?? execRun,
      'git',
      args,
      { cwd: this.context.cwd },
      this.context.logger,
    );
  }
}
