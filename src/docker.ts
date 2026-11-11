import SemanticReleaseError from '@semantic-release/error';
import {
  redactError,
  runLogged,
  type CommandContext,
} from './command-runner.js';
import { codeOf, messageOf, statusOf } from './utils/error.js';
import { run as execRun, type Runner } from './utils/exec.js';
import { isRecord } from './utils/object.js';
import { redactCredentials } from './utils/redact.js';

/**
 * A host directory mounted into the container.
 */
export interface Mount {
  /** Directory on the host. */
  readonly host: string;
  /** Path inside the container. */
  readonly container: string;
  /** Whether the mount is read-only. */
  readonly readonly?: boolean;
}

/**
 * Settings of a Docker image handle.
 */
export interface DockerImageOptions extends CommandContext {
  /** Image reference, including the tag. */
  readonly image: string;
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
 * @param image - Image reference.
 * @param args - Arguments for the container.
 * @param settings - Working directory, mounts, hosts, entrypoint and the names
 * of the environment variables to pass through.
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
 * @param value - An environment value.
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
 * Remove the values of environment variables from a piece of text, in the
 * forms the runtime might echo them. Values shorter than three characters
 * are left alone, because removing them would mangle the whole text.
 * @param text - Text about to be logged or put in an error.
 * @param env - The environment of the run.
 * @returns The text with the values replaced, and credentials in URLs hidden.
 */
function scrubValues(
  text: string,
  env: Readonly<Record<string, string>>,
): string {
  return redactCredentials(
    Object.values(env)
      .filter((value) => value.length >= 3)
      .flatMap(echoForms)
      .reduce((acc, form) => acc.split(form).join('***'), text),
  );
}

/**
 * The error to report when a run that carried environment variables fails.
 * A failure of the spawn itself (an `ERR_*` code) gets a fixed message that
 * names the variables and the code, and an empty message is replaced by a
 * fixed one. `code` and `status` are kept.
 * @param error - What the runner threw.
 * @param env - The environment of the failed run.
 * @returns A sanitised error.
 */
function withheld(
  error: unknown,
  env: Readonly<Record<string, string>>,
): Error {
  const names = Object.keys(env).join(', ');
  const code = codeOf(error);
  const status = statusOf(error);
  const keep = {
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
  };
  if (code?.startsWith('ERR_')) {
    return Object.assign(
      new Error(
        `Could not start docker (${code}) with the environment variable(s) ${names}; the message is withheld because it may contain their values.`,
      ),
      keep,
    );
  }
  const original =
    isRecord(error) && error.message === '' ? '' : messageOf(error);
  const scrubbed = scrubValues(original, env);
  if (scrubbed.trim().length === 0) {
    return Object.assign(
      new Error(
        `docker failed without a message; environment variable(s) ${names} were passed.`,
      ),
      keep,
    );
  }
  return Object.assign(new Error(scrubbed), keep);
}

/**
 * Check that the Docker CLI can be started and answers `docker version`.
 * @param context - Logger, directory and runner.
 * @throws SemanticReleaseError (`ENODOCKER`) when it cannot.
 */
export async function assertDockerAvailable(
  context: CommandContext,
): Promise<void> {
  try {
    await runLogged(
      context.run ?? execRun,
      'docker',
      ['version'],
      { cwd: context.cwd },
      context.logger,
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
 * A container image the tools run in, with the repository mounted at
 * `/apps`. It can be pulled and run; failures are mapped to coded errors so
 * callers never see argument lists or exit codes.
 */
export class DockerImage {
  private readonly options: DockerImageOptions;

  /**
   * @param options - Image reference, logger, repository directory, and
   * optional overrides of the runner, working directory, mounts and hosts.
   */
  constructor(options: DockerImageOptions) {
    this.options = options;
  }

  /**
   * The image reference, including the tag.
   * @returns The reference.
   */
  get reference(): string {
    return this.options.image;
  }

  /**
   * Pull the image.
   * @returns This image, once it is available locally.
   * @throws SemanticReleaseError (`EIMAGEPULLFAILED`) when the pull fails.
   */
  async pull(): Promise<DockerImage> {
    try {
      await runLogged(
        this.options.run ?? execRun,
        'docker',
        ['pull', this.options.image],
        { cwd: this.options.cwd },
        this.options.logger,
      );
    } catch (error) {
      throw new SemanticReleaseError(
        `Failed to pull Docker image: ${this.options.image}`,
        'EIMAGEPULLFAILED',
        redactCredentials(messageOf(error)),
      );
    }
    return this;
  }

  /**
   * Run a container of this image to completion with the repository mounted.
   * Credentials are redacted from every logged line and from the error that
   * is rethrown. When `options.env` is set, its values are also scrubbed
   * from the failure message, and a failure of the spawn itself is replaced
   * by a fixed message, because the runtime can echo a value in its own
   * message.
   * @param args - Arguments for the container.
   * @param options - Entrypoint override and environment variables.
   * @returns The trimmed standard output.
   * @throws The runner's error, sanitised.
   */
  async run(
    args: readonly string[],
    options: DockerRunOptions = {},
  ): Promise<string> {
    const env = options.env ?? {};
    const base = this.options.run ?? execRun;
    const hasEnv = Object.keys(env).length > 0;
    const runner: Runner = async (file, runArgs, runOptions) => {
      const output = await base(file, runArgs, runOptions);
      return hasEnv ? scrubValues(output, env) : output;
    };
    const sanitize = (error: unknown): Error => {
      if (hasEnv) {
        return withheld(error, env);
      }
      return redactError(error);
    };
    return runLogged(
      runner,
      'docker',
      dockerRunArgs(this.options.image, args, {
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
      sanitize,
    );
  }
}
