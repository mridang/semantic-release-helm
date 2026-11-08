import { execSync } from 'node:child_process';
import SemanticReleaseError from '@semantic-release/error';
import { messageOf } from '../utils/error.js';
import { quoteWord, shQuote } from '../utils/shell.js';
import { isRecord, stringAt } from '../utils/object.js';
import type {
  DockerClient,
  Logger,
  Mount,
  RunOptions,
  RunResult,
} from './client.js';

/**
 * Build a docker pull command string for a given image. The command
 * is deterministic and suitable for logging and testing.
 */
export function buildDockerPull(image: string): string {
  return `docker pull ${quoteWord(image)}`;
}

/**
 * Build a docker run command string. The command includes --rm, any
 * provided add-host entries, volume mounts, an optional entrypoint,
 * a working directory, the image, and argv. Every dynamic token is
 * shell-quoted, so spaces and metacharacters in paths, the image or flags
 * cannot split or inject commands. Environment variables are named only
 * (`--env=NAME`), so their values never appear in the command line.
 */
export function buildDockerRun(
  image: string,
  args: readonly string[],
  opts: {
    readonly workdir: string;
    readonly mounts: readonly Mount[];
    readonly addHosts: readonly string[];
    readonly entrypoint?: string;
    readonly envNames?: readonly string[];
  },
): string {
  const parts = [
    'docker run',
    '--rm',
    ...opts.addHosts.map((h) => quoteWord(`--add-host=${h}`)),
    ...opts.mounts.map((m) =>
      quoteWord(`--volume=${m.host}:${m.container}${m.readonly ? ':ro' : ''}`),
    ),
    ...(opts.envNames ?? []).map((n) => quoteWord(`--env=${n}`)),
    quoteWord(`--workdir=${opts.workdir}`),
    ...(opts.entrypoint ? [quoteWord(`--entrypoint=${opts.entrypoint}`)] : []),
    quoteWord(image),
  ];
  const quoted = args.map((a) =>
    a.startsWith('-') ? quoteWord(a) : shQuote(a),
  );
  return `${parts.join(' ')} ${quoted.join(' ')}`.trim();
}

/**
 * A synchronous runner function that executes a shell command with a
 * specific working directory and returns trimmed UTF-8 standard out.
 */
interface Runner {
  (
    cmd: string,
    cwd: string,
    env?: Readonly<Record<string, string>>,
  ): { stdout: string };
}

/**
 * Default runner that executes commands via execSync with UTF-8 text
 * decoding and returns the trimmed stdout for logging and callers.
 */
const defaultRunner: Runner = (cmd, cwd, env) => {
  const out = execSync(cmd, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
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
      envNames: Object.keys(opts.env ?? {}),
    });
    opts.logger.log(`$ ${cmd}`);
    try {
      const { stdout } = this.runFn(cmd, opts.cwd, opts.env);
      opts.logger.log(stdout.length ? stdout : '(no output)');
      return { stdout, code: 0 };
    } catch (e) {
      const names = Object.keys(opts.env ?? {});
      if (names.length > 0) {
        throw this.withheld(e, opts);
      }
      const msg = isRecord(e) ? stringAt(e, 'message') : undefined;
      if (msg) opts.logger.error(msg);
      throw e;
    }
  }

  /**
   * The error to report when a run that carried environment variables
   * fails. The runtime can echo a value in its own message (for instance
   * when it rejects a value containing a NUL byte), so a failure of the
   * spawn itself is replaced by a fixed message naming the variables, and
   * any other message has the values removed.
   *
   * @param error What the runner threw.
   * @param opts The options of the failed run.
   * @returns A sanitised error, already logged.
   */
  private withheld(error: unknown, opts: RunOptions): Error {
    const env = opts.env ?? {};
    const names = Object.keys(env).join(', ');
    const code = isRecord(error) ? stringAt(error, 'code') : undefined;
    const message = isRecord(error) ? (stringAt(error, 'message') ?? '') : '';
    const scrubbed = Object.values(env)
      .filter((value) => value.length > 0)
      .reduce(
        (text, value) =>
          text
            .split(value)
            .join('***')
            .split(JSON.stringify(value).slice(1, -1))
            .join('***'),
        message,
      );
    const safe = code?.startsWith('ERR_')
      ? `Could not start docker with the environment variable(s) ${names}; the message is withheld because it may contain their values.`
      : scrubbed;
    if (safe) opts.logger.error(safe);
    return new Error(safe);
  }
}
