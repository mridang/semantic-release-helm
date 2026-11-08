import SemanticReleaseError from '@semantic-release/error';
import { codeOf, messageOf } from './utils/error.js';
import { redactCredentials } from './utils/redact.js';
import { isRecord, stringAt } from './utils/object.js';
import type { ExecOptions, Runner } from './utils/exec.js';
import { quoteWord } from './utils/shell.js';

/**
 * The two logging methods the plugin uses. semantic-release's logger
 * satisfies this, and so does a plain object in tests.
 */
export interface Logger {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

/**
 * What every object that runs a program needs: a logger for the command
 * lines, the directory to run in, and the runner (the real no-shell one
 * unless a test injects a fake).
 */
export interface CommandContext {
  readonly logger: Logger;
  readonly cwd: string;
  readonly run?: Runner;
}

/**
 * A copy of a thrown value that is safe to log and rethrow: its message,
 * `stdout` and `stderr` are redacted, and its `code` and `status` are kept.
 * A `SemanticReleaseError` is returned as is, because its text is written
 * by this plugin.
 *
 * @param error Whatever was thrown.
 * @returns An error whose text holds no credentials.
 */
export function redactError(error: unknown): Error {
  if (error instanceof SemanticReleaseError) {
    return error;
  }
  const text = (key: string): Record<string, string> => {
    const value = isRecord(error) ? error[key] : undefined;
    return typeof value === 'string' ? { [key]: redactCredentials(value) } : {};
  };
  const code = codeOf(error);
  const status = isRecord(error) ? error.status : undefined;
  return Object.assign(new Error(redactCredentials(messageOf(error))), {
    ...(code === undefined ? {} : { code }),
    ...(typeof status === 'number' ? { status } : {}),
    ...text('stdout'),
    ...text('stderr'),
  });
}

/**
 * Log captured output when it has content: trimmed if that leaves text,
 * otherwise as captured.
 *
 * @param text The captured output.
 * @param logger Logger receiving the output.
 */
function logCaptured(text: string, logger: Logger): void {
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    logger.error(trimmed);
  } else if (text.length > 0) {
    logger.error(text);
  }
}

/**
 * Run a program through a runner and log what happens: the command line
 * first, then its output, or "(no output)". On failure the failing command
 * line, the captured output and the message are logged and the error is
 * rethrown. Credentials are redacted from everything that is logged and from
 * the rethrown error. The function knows nothing about what is being run.
 *
 * @param run The runner that executes the program.
 * @param file Program to run.
 * @param args Its arguments.
 * @param options Working directory and extra environment.
 * @param logger Receives the structured log lines.
 * @param sanitize Turns a failure into the error that is logged and thrown;
 *   defaults to redacting credentials, and a caller that passes secrets in
 *   the environment supplies one that also removes their values.
 * @returns Trimmed standard output.
 * @throws The sanitised error from the runner.
 */
export async function runLogged(
  run: Runner,
  file: string,
  args: readonly string[],
  options: ExecOptions,
  logger: Logger,
  sanitize: (error: unknown) => Error = redactError,
): Promise<string> {
  const display = redactCredentials([file, ...args].map(quoteWord).join(' '));
  logger.log(`$ ${display}`);

  try {
    const trimmed = (await run(file, args, options)).trim();
    logger.log(trimmed.length > 0 ? redactCredentials(trimmed) : '(no output)');
    return trimmed;
  } catch (error: unknown) {
    const safe = sanitize(error);
    logger.error(`Command failed: ${display}`);
    if (isRecord(safe)) {
      logCaptured(redactCredentials(stringAt(safe, 'stdout') ?? ''), logger);
      logCaptured(redactCredentials(stringAt(safe, 'stderr') ?? ''), logger);
      if (safe.message) {
        logger.error(redactCredentials(String(safe.message)));
      }
    }
    throw safe;
  }
}
