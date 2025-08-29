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
  pull(
    image: string,
    logger: { log: (m: string) => void; error: (m: string) => void },
  ): Promise<void>;

  run(
    image: string,
    args: string[],
    opts: {
      cwd: string;
      workdir?: string;
      mounts?: Array<{
        host: string;
        container: string;
        readonly?: boolean;
      }>;
      addHosts?: string[];
      entrypoint?: string;
      logger: { log: (m: string) => void; error: (m: string) => void };
    },
  ): Promise<RunResult>;
}
