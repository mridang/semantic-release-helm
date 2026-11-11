/**
 * @file Runs external commands with logging, credential redaction and normalised errors.
 */
import SemanticReleaseError from '@semantic-release/error';
import { codeOf, messageOf } from './utils/error.js';
import { redactCredentials } from './utils/redact.js';
import { isRecord, stringAt } from './utils/object.js';
import type { ExecOptions, Runner } from './utils/exec.js';
import { quoteWord } from './utils/shell.js';

/**
 * The two logging methods the plugin uses. Semantic-release's logger
 * satisfies this, and so does a plain object in tests.
 */
export interface Logger {
  /** Write an informational line. */
  readonly log: (message: string) => void;
  /** Write an error line. */
  readonly error: (message: string) => void;
}

/**
 * What every object that runs a program needs: a logger for the command
 * lines, the directory to run in, and the runner (the real no-shell one
 * unless a test injects a fake).
 */
export interface CommandContext {
  /** Receives the command lines and their output. */
  readonly logger: Logger;
  /** Directory the programs run in. */
  readonly cwd: string;
  /** Runs a program without a shell; tests inject a fake. */
  readonly run?: Runner;
}

/**
 * A copy of a thrown value that is safe to log and rethrow: its message, stdout and stderr are
 * redacted, and its code and status are kept. A SemanticReleaseError is returned as it is,
 * because its text is written by this plugin.
 * @param error - Whatever was thrown.
 * @returns An error whose text holds no credentials.
 * @example
 * ```ts
 * const safe = redactError(new Error('clone https://user:secret@example.com/repo failed'));
 * safe.message; // 'clone https://user:***@example.com/repo failed'
 * ```
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
 * Log captured output when it has content: the trimmed text when that leaves any, otherwise the
 * text as captured. Nothing is logged for empty output.
 * @param text - The captured output.
 * @param logger - Logger receiving the output.
 * @example
 * ```ts
 * logCaptured('  warning: stale lock  \n', logger); // logs "warning: stale lock"
 * ```
 */
function logCaptured(text: string, logger: Logger): void {
  if (text.length > 0) {
    const trimmed = text.trim();
    logger.error(trimmed.length > 0 ? trimmed : text);
  }
}

/**
 * Run a program through a runner and log what happens: the command line first, then its output,
 * or "(no output)". On failure the failing command line, the captured output and the message are
 * logged and the error is rethrown. Credentials are redacted from everything logged and from the
 * rethrown error. The function knows nothing about what is being run.
 * @param run - The runner that executes the program.
 * @param file - Program to run.
 * @param args - Its arguments.
 * @param options - Working directory and extra environment.
 * @param logger - Receives the structured log lines.
 * @param sanitize - Turns a failure into the error that is logged and thrown. Defaults to redacting
 * credentials; a caller that passes secrets in the environment supplies one that also removes them.
 * @returns Trimmed standard output.
 * @rejects The sanitised error from the runner.
 * @example
 * ```ts
 * const version = await runLogged(run, 'git', ['--version'], { cwd: '/repo' }, logger);
 * ```
 */
export async function runLogged(
  run: Runner,
  file: string,
  args: readonly string[],
  options: ExecOptions,
  logger: Logger,
  sanitize: (error: unknown) => Error = redactError,
): Promise<string> {
  const display = redactCredentials(
    [file, ...args].map((part) => quoteWord(part)).join(' '),
  );
  logger.log(`$ ${display}`);

  try {
    const output = await run(file, args, options);
    const trimmed = output.trim();
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
