import { runLogged, type CommandContext } from './command-runner.js';
import { run as execRun } from './utils/exec.js';
import type { RemoteUrl } from './remote-url.js';

/**
 * A branch of a repository: its name, the remote it tracks if any, and the
 * working tree it is checked out in if any.
 */
export interface Branch {
  readonly name: string;
  readonly remote?: string;
  readonly directory?: string;
}

/**
 * Settings of a remote handle.
 */
export interface RemoteOptions extends CommandContext {
  readonly name: string;
  readonly url: RemoteUrl;
}

/**
 * A git remote of the repository: it can say whether it can be reached,
 * fetch a branch, and receive a push.
 */
export class Remote {
  private readonly options: RemoteOptions;

  /**
   * @param options Name, address, logger, directory and runner.
   */
  constructor(options: RemoteOptions) {
    this.options = options;
  }

  /**
   * The name of the remote, such as `origin`.
   *
   * @returns The name.
   */
  get name(): string {
    return this.options.name;
  }

  /**
   * The address of the remote.
   *
   * @returns The remote URL.
   */
  get url(): RemoteUrl {
    return this.options.url;
  }

  /**
   * Whether the remote can be reached with the current credentials. Only the
   * exit status is used and the output is discarded, so a remote with a very
   * large number of branches cannot overflow a buffer.
   *
   * @returns True when `git ls-remote` succeeds.
   */
  async isReachable(): Promise<boolean> {
    try {
      await (this.options.run ?? execRun)(
        'git',
        ['ls-remote', '--heads', this.options.name],
        { cwd: this.options.cwd },
      );
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Fetch one branch.
   *
   * @param branch Branch name.
   * @returns The branch as fetched, or undefined when the remote has no such
   *   branch or cannot be reached.
   */
  async fetch(branch: string): Promise<Branch | undefined> {
    try {
      await this.git(['fetch', this.options.name, branch]);
    } catch {
      return undefined;
    }
    return { name: branch, remote: this.options.name };
  }

  /**
   * Push a branch to this remote.
   *
   * @param branch The branch; when it is checked out in a working tree the
   *   push runs from there.
   */
  async push(branch: Branch): Promise<void> {
    const from = branch.directory === undefined ? [] : ['-C', branch.directory];
    await this.git([...from, 'push', this.options.name, branch.name]);
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
