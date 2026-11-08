/**
 * The two logging methods the plugin uses. semantic-release's logger
 * satisfies this, and so does a plain object in tests.
 */
export interface Logger {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

/**
 * A host directory mounted into the container.
 */
export interface Mount {
  readonly host: string;
  readonly container: string;
  readonly readonly?: boolean;
}

/**
 * Options for a single container run.
 */
export interface RunOptions {
  readonly cwd: string;
  readonly workdir?: string;
  readonly mounts?: readonly Mount[];
  readonly addHosts?: readonly string[];
  readonly entrypoint?: string;
  readonly logger: Logger;
}

/**
 * A result object representing a completed container run. The object
 * contains the trimmed standard output and an exit code. The exit
 * code is always zero for successful synchronous runs in this layer.
 */
export interface RunResult {
  stdout: string;
  code: number;
}

/**
 * A transport-agnostic client for container execution. The interface
 * is intentionally narrow to enable stable call sites while allowing
 * future backends without changes to plugin code.
 */
export interface DockerClient {
  pull(image: string, logger: Logger): Promise<void>;

  run(
    image: string,
    args: readonly string[],
    opts: RunOptions,
  ): Promise<RunResult>;
}
