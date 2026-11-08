import { redactCredentials, redactError } from './utils/redact.js';
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
