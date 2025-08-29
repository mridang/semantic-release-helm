import { execSync } from 'node:child_process';
// @ts-expect-error semantic-release types are not bundled
import SemanticReleaseError from '@semantic-release/error';
import type { DockerClient, RunResult } from './client.js';

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
  args: string[],
  opts: {
    workdir: string;
    mounts: Array<{ host: string; container: string; readonly?: boolean }>;
    addHosts: string[];
    entrypoint?: string;
  },
): string {
  const parts: string[] = ['docker run', '--rm'];
  for (const h of opts.addHosts) parts.push(`--add-host=${h}`);
  for (const m of opts.mounts) {
    const ro = m.readonly ? ':ro' : '';
    parts.push(`--volume=${m.host}:${m.container}${ro}`);
  }
  parts.push(`--workdir=${opts.workdir}`);
  if (opts.entrypoint) parts.push(`--entrypoint=${opts.entrypoint}`);
  parts.push(image);
  const quoted = args.map((a) => (a.startsWith('-') ? a : shQuote(a)));
  return `${parts.join(' ')} ${quoted.join(' ')}`.trim();
}

/**
 * A synchronous runner function that executes a shell command with a
 * specific working directory and returns trimmed UTF-8 standard out.
 */
export interface Runner {
  (cmd: string, cwd: string): { stdout: string };
}

/**
 * Default runner that executes commands via execSync with UTF-8 text
 * decoding and returns the trimmed stdout for logging and callers.
 */
export const defaultRunner: Runner = (cmd, cwd) => {
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

  async pull(
    image: string,
    logger: { log: (m: string) => void; error: (m: string) => void },
  ): Promise<void> {
    const cmd = buildDockerPull(image);
    logger.log(`$ ${cmd}`);
    try {
      const { stdout } = this.runFn(cmd, process.cwd());
      logger.log(stdout.length ? stdout : '(no output)');
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : 'Unknown error while pulling image';
      throw new SemanticReleaseError(
        `Failed to pull Docker image: ${image}`,
        'EIMAGEPULLFAILED',
        msg,
      );
    }
  }

  async run(
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
  ): Promise<RunResult> {
    const workdir = opts.workdir ?? '/apps';
    const mounts = opts.mounts ?? [
      { host: opts.cwd, container: '/apps', readonly: false },
    ];
    const addHosts = opts.addHosts ?? ['host.docker.internal:host-gateway'];
    const cmd = buildDockerRun(image, args, {
      workdir,
      mounts,
      addHosts,
      entrypoint: opts.entrypoint,
    });
    opts.logger.log(`$ ${cmd}`);
    try {
      const { stdout } = this.runFn(cmd, opts.cwd);
      opts.logger.log(stdout.length ? stdout : '(no output)');
      return { stdout, code: 0 };
    } catch (e) {
      if (typeof e === 'object' && e !== null) {
        const msg = (e as { message?: string }).message;
        if (msg) opts.logger.error(msg);
      }
      throw e;
    }
  }
}
