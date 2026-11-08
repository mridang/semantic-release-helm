// src/command-runner.ts
import { execSync } from 'node:child_process';
import type { Logger } from './docker/client.js';
import { isRecord, stringAt } from './utils/object.js';

/**
 * Decode captured process output, which `execSync` attaches to its error as
 * a string or a Buffer.
 *
 * @param value The `stdout` or `stderr` property of the error.
 * @returns The text, or an empty string when there is none.
 */
function textOf(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
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
 * Execute a host command and return its trimmed stdout. All interactions are
 * logged to the provided semantic-release logger. If the command produces no
 * stdout, "(no output)" is logged for traceability.
 *
 * On failure, the function logs the failing command, tries to log captured
 * stdout and stderr from the thrown error object, and rethrows the original
 * error to preserve the exit semantics. The command is executed with stdio
 * "pipe" and UTF-8 decoding so that stdout can be captured and returned to
 * callers. The working directory is set to the repository root.
 *
 * @param cmd Shell command to execute.
 * @param cwd Working directory for the command.
 * @param logger semantic-release logger used for structured logs.
 * @returns Trimmed stdout of the command.
 * @throws Any error thrown by execSync is rethrown after being logged.
 */
export function runHostCmd(cmd: string, cwd: string, logger: Logger): string {
  logger.log(`$ ${cmd}`);

  try {
    const out = execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' });
    const trimmed = out.trim();

    logger.log(trimmed.length > 0 ? trimmed : '(no output)');

    return trimmed;
  } catch (err: unknown) {
    logger.error(`Command failed: ${cmd}`);

    if (isRecord(err)) {
      logCaptured(textOf(err.stdout), logger);
      logCaptured(textOf(err.stderr), logger);

      const message = stringAt(err, 'message');
      if (message !== undefined && message.length > 0) {
        logger.error(message);
      }
    }

    throw err;
  }
}
