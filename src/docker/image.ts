import type { DockerClient, Logger, Mount, RunOptions } from './client.js';
import { DockerCliClient } from './cli-client.js';

/**
 * Options controlling execution defaults for a specific image instance.
 * Values apply to all runs through the wrapper for that instance only.
 */
interface DockerImageOptions {
  readonly workdir?: string;
  readonly mounts?: readonly Mount[];
  readonly addHosts?: readonly string[];
}

/**
 * A high-level facade representing a concrete image with stable run
 * semantics. The wrapper binds an image tag to a working directory
 * and logger, and exposes methods for pull, run, and shell execution.
 */
export class DockerImage {
  private readonly image: string;
  private readonly cwd: string;
  private readonly logger: Logger;
  private readonly client: DockerClient;
  private readonly opts: DockerImageOptions;

  constructor(
    image: string,
    cwd: string,
    logger: Logger,
    client: DockerClient = new DockerCliClient(),
    opts: DockerImageOptions = {},
  ) {
    this.image = image;
    this.cwd = cwd;
    this.logger = logger;
    this.client = client;
    this.opts = opts;
  }

  /**
   * Pull the image through the configured client. On failure, the
   * client is expected to raise a SemanticReleaseError with a stable
   * code so callers can produce actionable diagnostics.
   */
  async pullOrThrow(): Promise<void> {
    await this.client.pull(this.image, this.logger);
  }

  /**
   * Run the image with the provided arguments. The method applies
   * default host mapping, mount, and working directory policies to
   * match current plugin behavior with a single call.
   */
  async run(args: readonly string[]): Promise<void> {
    await this.client.run(this.image, args, this.runOptions());
  }

  /**
   * Run a POSIX shell script inside the container. The method sets
   * the entrypoint to /bin/sh and executes the script with -lc so
   * a new shell interprets the script in one argument. Values in `env`
   * are handed to the script as environment variables, never in its text.
   */
  async shell(
    script: string,
    env?: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.client.run(this.image, ['-lc', script], {
      ...this.runOptions(),
      entrypoint: '/bin/sh',
      env,
    });
  }

  /**
   * The run options shared by every run: the plugin's defaults overlaid
   * with this instance's overrides.
   *
   * @returns Options for the client.
   */
  private runOptions(): RunOptions {
    return {
      cwd: this.cwd,
      workdir: this.opts.workdir ?? '/apps',
      mounts: this.opts.mounts ?? [
        { host: this.cwd, container: '/apps', readonly: false },
      ],
      addHosts: this.opts.addHosts ?? ['host.docker.internal:host-gateway'],
      logger: this.logger,
    };
  }
}
