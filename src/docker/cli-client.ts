import { execSync } from 'node:child_process';
import SemanticReleaseError from '@semantic-release/error';
import { messageOf } from '../utils/error.js';
import { isRecord, stringAt } from '../utils/object.js';
import type {
  DockerClient,
  Logger,
  Mount,
  RunOptions,
  RunResult,
} from './client.js';

/**
 * Quote a shell argument for POSIX sh using single quotes. Embedded
 * single quotes are escaped by closing, inserting an escaped quote,
 * and reopening. The function performs no environment expansion.
 */
export function shQuote(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a docker pull command string for a given image. The command
 * is deterministic and suitable for logging and testing.
 */
export function buildDockerPull(image: string): string {
  return `docker pull ${image}`;
}

/**
 * Build a docker run command string. The command includes --rm, any
 * provided add-host entries, volume mounts, an optional entrypoint,
 * a working directory, the image, and argv. Non-option argv tokens
 * are single-quoted via shQuote to preserve spaces reliably.
 */
export function buildDockerRun(
  image: string,
  args: readonly string[],
  opts: {
    readonly workdir: string;
    readonly mounts: readonly Mount[];
    readonly addHosts: readonly string[];
    readonly entrypoint?: string;
  },
): string {
  const parts = [
    'docker run',
    '--rm',
    ...opts.addHosts.map((h) => `--add-host=${h}`),
    ...opts.mounts.map(
      (m) => `--volume=${m.host}:${m.container}${m.readonly ? ':ro' : ''}`,
    ),
    `--workdir=${opts.workdir}`,
    ...(opts.entrypoint ? [`--entrypoint=${opts.entrypoint}`] : []),
    image,
  ];
  const quoted = args.map((a) => (a.startsWith('-') ? a : shQuote(a)));
  return `${parts.join(' ')} ${quoted.join(' ')}`.trim();
}

/**
 * A synchronous runner function that executes a shell command with a
 * specific working directory and returns trimmed UTF-8 standard out.
 */
interface Runner {
  (cmd: string, cwd: string): { stdout: string };
}

/**
 * Default runner that executes commands via execSync with UTF-8 text
 * decoding and returns the trimmed stdout for logging and callers.
 */
const defaultRunner: Runner = (cmd, cwd) => {
  const out = execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
  return { stdout: out };
};

/**
 * A Docker client backed by the local Docker CLI. The implementation
 * composes deterministic command strings and delegates execution to a
 * configurable runner. The default runner uses execSync.
 */
export class DockerCliClient implements DockerClient {
  private readonly runFn: Runner;

  constructor(runFn: Runner = defaultRunner) {
    this.runFn = runFn;
  }

  async pull(image: string, logger: Logger): Promise<void> {
    const cmd = buildDockerPull(image);
    logger.log(`$ ${cmd}`);
    try {
      const { stdout } = this.runFn(cmd, process.cwd());
      logger.log(stdout.length ? stdout : '(no output)');
    } catch (e) {
      throw new SemanticReleaseError(
        `Failed to pull Docker image: ${image}`,
        'EIMAGEPULLFAILED',
        messageOf(e),
      );
    }
  }

  async run(
    image: string,
    args: readonly string[],
    opts: RunOptions,
  ): Promise<RunResult> {
    const cmd = buildDockerRun(image, args, {
      workdir: opts.workdir ?? '/apps',
      mounts: opts.mounts ?? [
        { host: opts.cwd, container: '/apps', readonly: false },
      ],
      addHosts: opts.addHosts ?? ['host.docker.internal:host-gateway'],
      entrypoint: opts.entrypoint,
    });
    opts.logger.log(`$ ${cmd}`);
    try {
      const { stdout } = this.runFn(cmd, opts.cwd);
      opts.logger.log(stdout.length ? stdout : '(no output)');
      return { stdout, code: 0 };
    } catch (e) {
      const msg = isRecord(e) ? stringAt(e, 'message') : undefined;
      if (msg) opts.logger.error(msg);
      throw e;
    }
  }
}
