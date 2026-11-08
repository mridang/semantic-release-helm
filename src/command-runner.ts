// src/command-runner.ts
import { execSync } from 'node:child_process';
import type { Logger } from './docker/client.js';
import { isRecord, stringAt } from './utils/object.js';

/**
 * Hide the user and password of any URL in a piece of log text, so a remote
 * such as `https://x-access-token:TOKEN@host/o/r.git` never reaches a log.
 *
 * @param text Text about to be logged.
 * @returns The text with `scheme://user:pass@` reduced to `scheme://***@`.
 */
function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@');
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
    logger.error(redactCredentials(trimmed));
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
 * callers. The working directory is set to the repository root. Credentials
 * embedded in URLs are redacted from everything that is logged.
 *
 * @param cmd Shell command to execute.
 * @param cwd Working directory for the command.
 * @param logger semantic-release logger used for structured logs.
 * @returns Trimmed stdout of the command.
 * @throws Any error thrown by execSync is rethrown after being logged.
 */
export function runHostCmd(cmd: string, cwd: string, logger: Logger): string {
  logger.log(`$ ${redactCredentials(cmd)}`);

  try {
    const out = execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' });
    const trimmed = out.trim();

    logger.log(trimmed.length > 0 ? redactCredentials(trimmed) : '(no output)');

    return trimmed;
  } catch (err: unknown) {
    logger.error(`Command failed: ${redactCredentials(cmd)}`);

    if (isRecord(err)) {
      logCaptured(stringAt(err, 'stdout') ?? '', logger);
      logCaptured(stringAt(err, 'stderr') ?? '', logger);

      const message = stringAt(err, 'message');
      if (message !== undefined && message.length > 0) {
        logger.error(redactCredentials(message));
      }
    }

    throw err;
  }
}
