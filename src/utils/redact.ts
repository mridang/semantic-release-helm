import SemanticReleaseError from '@semantic-release/error';
import { codeOf, messageOf } from './error.js';
import { isRecord } from './object.js';

/**
 * Hide credentials in a piece of text that is about to be logged or put in an
 * error message. This is a backstop that works on the shape of the text; the
 * primary defence is not to put secrets in text at all.
 *
 * Covered: `scheme://user:password@` (the password may contain `@` and `/`,
 * and the scheme may be any case), `scheme://token@`, `token=`,
 * `access_token=`, `password=` and `private_token=` query values,
 * `Authorization:` header lines, `Bearer` tokens, and bare GitHub and GitLab
 * tokens (`ghp_`, `github_pat_`, `glpat-`).
 *
 * @param text Text that may contain credentials.
 * @returns The text with every credential replaced by `***`.
 */
export function redactCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:\S*@/gi, '$1***@')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+@/gi, '$1***@')
    .replace(
      /([?&](?:access_token|token|password|private_token)=)[^&\s#'"]+/gi,
      '$1***',
    )
    .replace(/\b((?:proxy-)?authorization)\s*:[^\r\n]*/gi, '$1: ***')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,})/g,
      '***',
    );
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
