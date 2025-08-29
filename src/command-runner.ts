// src/command-runner.ts
import { execSync } from 'node:child_process';
// @ts-expect-error semantic-release types are not bundled
import { Context } from 'semantic-release';

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
export function runHostCmd(
  cmd: string,
  cwd: string,
  logger: Context['logger'],
): string {
  const stringify = (v: unknown): string => {
    if (typeof v === 'string') {
      return v;
    } else {
      if (Buffer.isBuffer(v)) {
        return v.toString('utf8');
      } else {
        return '';
      }
    }
  };

  logger.log(`$ ${cmd}`);

  try {
    const out = execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' });
    const trimmed = out.trim();

    if (trimmed.length > 0) {
      logger.log(trimmed);
    } else {
      logger.log('(no output)');
    }

    return trimmed;
  } catch (err: unknown) {
    logger.error(`Command failed: ${cmd}`);

    if (typeof err === 'object' && err !== null) {
      const e = err as {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      };

      const out = stringify(e.stdout);
      const errOut = stringify(e.stderr);
      const outTrimmed = out.trim();
      const errTrimmed = errOut.trim();

      if (outTrimmed.length > 0) {
        logger.error(outTrimmed);
      } else {
        if (out.length > 0) {
          logger.error(out);
        }
      }

      if (errTrimmed.length > 0) {
        logger.error(errTrimmed);
      } else {
        if (errOut.length > 0) {
          logger.error(errOut);
        }
      }

      if (typeof e.message === 'string' && e.message.length > 0) {
        logger.error(e.message);
      }
    }

    throw err;
  }
}

// noinspection JSUnusedGlobalSymbols
export default { runHostCmd };
