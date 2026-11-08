import { execSync } from 'node:child_process';
import SemanticReleaseError from '@semantic-release/error';
import { codeOf, messageOf } from '../utils/error.js';
import { redactCredentials, redactError } from '../utils/redact.js';
import { quoteWord, shQuote } from '../utils/shell.js';
import { isRecord } from '../utils/object.js';
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
    maxBuffer: 64 * 1024 * 1024,
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

  /**
   * @param runFn Executes a command line; defaults to `execSync`. Tests
   *   inject a fake.
   */
  constructor(runFn: Runner = defaultRunner) {
    this.runFn = runFn;
  }

  /**
   * Pull an image.
   *
   * @param image Image reference.
   * @param logger Receives the command and its output, with credentials
   *   redacted.
   * @throws SemanticReleaseError (`EIMAGEPULLFAILED`) when the pull fails.
   */
  async pull(image: string, logger: Logger): Promise<void> {
    const cmd = buildDockerPull(image);
    logger.log(redactCredentials(`$ ${cmd}`));
    try {
      const { stdout } = this.runFn(cmd, process.cwd());
      logger.log(redactCredentials(stdout.length ? stdout : '(no output)'));
    } catch (e) {
      throw new SemanticReleaseError(
        `Failed to pull Docker image: ${image}`,
        'EIMAGEPULLFAILED',
        redactCredentials(messageOf(e)),
      );
    }
  }

  /**
   * Run a container to completion. Credentials are redacted from every
   * logged line and from the error that is rethrown. When `opts.env` is set,
   * the values are also scrubbed from the failure message, and a failure of
   * the spawn itself is replaced by a fixed message, because the runtime can
   * echo a value in its own message.
   *
   * @param image Image reference.
   * @param args Arguments for the container.
   * @param opts Working directory, mounts, entrypoint, environment, logger.
   * @returns The trimmed stdout and a zero exit code.
   * @throws The runner's error, sanitised.
   */
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
    opts.logger.log(redactCredentials(`$ ${cmd}`));
    try {
      const { stdout } = this.runFn(cmd, opts.cwd, opts.env);
      opts.logger.log(
        redactCredentials(stdout.length ? stdout : '(no output)'),
      );
      return { stdout, code: 0 };
    } catch (e) {
      const failure =
        Object.keys(opts.env ?? {}).length > 0
          ? withheld(e, opts.env ?? {})
          : redactError(e);
      if (failure.message) opts.logger.error(failure.message);
      throw failure;
    }
  }
}

/**
 * The forms in which the runtime might echo an environment value.
 *
 * @param value An environment value.
 * @returns The raw, JSON-escaped, URL-encoded and base64 forms.
 */
function echoForms(value: string): readonly string[] {
  return [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    Buffer.from(value).toString('base64'),
  ];
}

/**
 * The error to report when a run that carried environment variables fails.
 * Values shorter than three characters are not scrubbed, because removing
 * them would mangle the whole message. A failure of the spawn itself (an
 * `ERR_*` code) gets a fixed message that names the variables and the code,
 * and an empty message is replaced by a fixed one. `code` and `status` are
 * kept.
 *
 * @param error What the runner threw.
 * @param env The environment of the failed run.
 * @returns A sanitised error.
 */
function withheld(
  error: unknown,
  env: Readonly<Record<string, string>>,
): Error {
  const names = Object.keys(env).join(', ');
  const code = codeOf(error);
  const scrub = (text: string): string =>
    redactCredentials(
      Object.values(env)
        .filter((value) => value.length >= 3)
        .flatMap(echoForms)
        .reduce((acc, form) => acc.split(form).join('***'), text),
    );
  const scrubbed = scrub(messageOf(error));
  const safe = code?.startsWith('ERR_')
    ? `Could not start docker (${code}) with the environment variable(s) ${names}; the message is withheld because it may contain their values.`
    : scrubbed.trim().length > 0
      ? scrubbed
      : `docker failed without a message; environment variable(s) ${names} were passed.`;
  const status = isRecord(error) ? error.status : undefined;
  return Object.assign(new Error(safe), {
    ...(code === undefined ? {} : { code }),
    ...(typeof status === 'number' ? { status } : {}),
  });
}
