import SemanticReleaseError from '@semantic-release/error';
import { runLogged, type Logger } from './command-runner.js';
import { codeOf, messageOf, statusOf } from './utils/error.js';
import { run as execRun, type Runner } from './utils/exec.js';
import { isRecord } from './utils/object.js';
import { redactCredentials, redactError } from './utils/redact.js';

/**
 * A host directory mounted into the container.
 */
export interface Mount {
  readonly host: string;
  readonly container: string;
  readonly readonly?: boolean;
}

/**
 * Settings of a Docker client. Only `logger` and `cwd` are required.
 */
export interface DockerOptions {
  /** Receives the command lines and their output. */
  readonly logger: Logger;
  /** Host directory that is mounted at `/apps` and used as the working directory. */
  readonly cwd: string;
  /** Runs `docker`; defaults to the real no-shell runner. Tests inject a fake. */
  readonly run?: Runner;
  /** Working directory inside the container. Defaults to `/apps`. */
  readonly workdir?: string;
  /** Mounts. Defaults to `cwd` at `/apps`. */
  readonly mounts?: readonly Mount[];
  /** `--add-host` entries. Defaults to `host.docker.internal:host-gateway`. */
  readonly addHosts?: readonly string[];
}

/**
 * Per-run options.
 */
export interface DockerRunOptions {
  /** Replaces the image entrypoint. */
  readonly entrypoint?: string;
  /**
   * Variables for the container. Only their names reach the command line;
   * the values travel through the environment of the `docker` process.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The argument list of `docker run` for an image. Every value is a separate
 * argument, so nothing needs quoting.
 *
 * @param image Image reference.
 * @param args Arguments for the container.
 * @param settings Working directory, mounts, hosts, entrypoint and the names
 *   of the environment variables to pass through.
 * @returns The arguments that follow `docker`.
 */
export function dockerRunArgs(
  image: string,
  args: readonly string[],
  settings: {
    readonly workdir: string;
    readonly mounts: readonly Mount[];
    readonly addHosts: readonly string[];
    readonly entrypoint?: string;
    readonly envNames?: readonly string[];
  },
): string[] {
  return [
    'run',
    '--rm',
    ...settings.addHosts.map((h) => `--add-host=${h}`),
    ...settings.mounts.map(
      (m) => `--volume=${m.host}:${m.container}${m.readonly ? ':ro' : ''}`,
    ),
    `--workdir=${settings.workdir}`,
    ...(settings.entrypoint ? [`--entrypoint=${settings.entrypoint}`] : []),
    ...(settings.envNames ?? []).map((n) => `--env=${n}`),
    image,
    ...args,
  ];
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
  const scrubbed =
    isRecord(error) && error.message === '' ? '' : scrub(messageOf(error));
  const safe = code?.startsWith('ERR_')
    ? `Could not start docker (${code}) with the environment variable(s) ${names}; the message is withheld because it may contain their values.`
    : scrubbed.trim().length > 0
      ? scrubbed
      : `docker failed without a message; environment variable(s) ${names} were passed.`;
  const status = statusOf(error);
  return Object.assign(new Error(safe), {
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
  });
}

/**
 * Everything the plugin does with Docker: check that it is installed, pull
 * images, and run a container with the repository mounted. All failures are
 * mapped to coded errors here, so callers never see argv or exit codes.
 */
export class DockerClient {
  private readonly options: DockerOptions;

  private readonly runner: Runner;

  /**
   * @param options Logger, repository directory, and optional overrides of
   *   the runner, working directory, mounts and hosts.
   */
  constructor(options: DockerOptions) {
    this.options = options;
    this.runner = options.run ?? execRun;
  }

  /**
   * Check that the Docker CLI can be started and answers `docker version`.
   *
   * @throws SemanticReleaseError (`ENODOCKER`) when it cannot.
   */
  async assertAvailable(): Promise<void> {
    try {
      await runLogged(
        this.runner,
        'docker',
        ['version'],
        { cwd: this.options.cwd },
        this.options.logger,
      );
    } catch {
      throw new SemanticReleaseError(
        'Docker not available.',
        'ENODOCKER',
        'Docker must be installed and on PATH.',
      );
    }
  }

  /**
   * Pull an image.
   *
   * @param image Image reference.
   * @throws SemanticReleaseError (`EIMAGEPULLFAILED`) when the pull fails.
   */
  async pull(image: string): Promise<void> {
    try {
      await runLogged(
        this.runner,
        'docker',
        ['pull', image],
        { cwd: this.options.cwd },
        this.options.logger,
      );
    } catch (error) {
      throw new SemanticReleaseError(
        `Failed to pull Docker image: ${image}`,
        'EIMAGEPULLFAILED',
        redactCredentials(messageOf(error)),
      );
    }
  }

  /**
   * Run a container to completion with the repository mounted. Credentials
   * are redacted from every logged line and from the error that is rethrown.
   * When `options.env` is set, its values are also scrubbed from the failure
   * message, and a failure of the spawn itself is replaced by a fixed
   * message, because the runtime can echo a value in its own message.
   *
   * @param image Image reference.
   * @param args Arguments for the container.
   * @param options Entrypoint override and environment variables.
   * @returns The trimmed standard output.
   * @throws The runner's error, sanitised.
   */
  async run(
    image: string,
    args: readonly string[],
    options: DockerRunOptions = {},
  ): Promise<string> {
    const env = options.env ?? {};
    const hasEnv = Object.keys(env).length > 0;
    return runLogged(
      this.runner,
      'docker',
      dockerRunArgs(image, args, {
        workdir: this.options.workdir ?? '/apps',
        mounts: this.options.mounts ?? [
          { host: this.options.cwd, container: '/apps', readonly: false },
        ],
        addHosts: this.options.addHosts ?? [
          'host.docker.internal:host-gateway',
        ],
        entrypoint: options.entrypoint,
        envNames: Object.keys(env),
      }),
      { cwd: this.options.cwd, env },
      this.options.logger,
      hasEnv ? (error) => withheld(error, env) : redactError,
    );
  }
}
