import type { DockerClient } from './client.js';
import { DockerCliClient } from './cli-client.js';

/**
 * Options controlling execution defaults for a specific image instance.
 * Values apply to all runs through the wrapper for that instance only.
 */
export interface DockerImageOptions {
  workdir?: string;
  mounts?: Array<{
    host: string;
    container: string;
    readonly?: boolean;
  }>;
  addHosts?: string[];
}

/**
 * A high-level facade representing a concrete image with stable run
 * semantics. The wrapper binds an image tag to a working directory
 * and logger, and exposes methods for pull, run, and shell execution.
 */
export class DockerImage {
  private readonly image: string;
  private readonly cwd: string;
  private readonly logger: {
    log: (m: string) => void;
    error: (m: string) => void;
  };
  private readonly client: DockerClient;
  private readonly opts: DockerImageOptions;

  constructor(
    image: string,
    cwd: string,
    logger: { log: (m: string) => void; error: (m: string) => void },
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
  async run(args: string[]): Promise<void> {
    await this.client.run(this.image, args, {
      cwd: this.cwd,
      workdir: this.opts.workdir ?? '/apps',
      mounts: this.opts.mounts ?? [
        { host: this.cwd, container: '/apps', readonly: false },
      ],
      addHosts: this.opts.addHosts ?? ['host.docker.internal:host-gateway'],
      logger: this.logger,
    });
  }

  /**
   * Run a POSIX shell script inside the container. The method sets
   * the entrypoint to /bin/sh and executes the script with -lc so
   * a new shell interprets the script in one argument.
   */
  async shell(script: string): Promise<void> {
    await this.client.run(this.image, ['-lc', script], {
      cwd: this.cwd,
      workdir: this.opts.workdir ?? '/apps',
      mounts: this.opts.mounts ?? [
        { host: this.cwd, container: '/apps', readonly: false },
      ],
      addHosts: this.opts.addHosts ?? ['host.docker.internal:host-gateway'],
      entrypoint: '/bin/sh',
      logger: this.logger,
    });
  }
}
