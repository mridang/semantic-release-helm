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
 * @param text - Text that may contain credentials.
 * @returns The text with every credential replaced by `***`.
 */
export function redactCredentials(text: string): string {
  return maskUserinfo(
    maskUserinfo(text, passwordUserinfoEnds()),
    tokenUserinfoEnd,
  )
    .replaceAll(
      /([?&](?:access_token|token|password|private_token)=)[^&\s#'"]+/gi,
      '$1***',
    )
    .replaceAll(/\b((?:proxy-)?authorization)\s*:[^\r\n]*/gi, '$1: ***')
    .replaceAll(/\bbearer\s+[\w.~+/=-]+/gi, 'Bearer ***')
    .replaceAll(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[A-Za-z0-9_-]{16,})/g,
      '***',
    );
}

const SCHEME_CHAR = /[a-z0-9+.-]/i;
const LETTER = /[a-z]/i;
const SEPARATOR = /[\s/@:]/;
const WHITESPACE = /\s/;

/**
 * Whether a URL scheme ends at `index`: the run of scheme characters just before it holds a letter,
 * so a scheme (`[a-z][a-z0-9+.-]*`) can start inside it.
 * @param text - The text being scanned.
 * @param index - Where `://` starts.
 * @returns True when a scheme precedes the index.
 */
function hasSchemeBefore(text: string, index: number): boolean {
  let found = false;
  for (let i = index - 1; i >= 0; i -= 1) {
    const char = text.charAt(i);
    if (!SCHEME_CHAR.test(char)) {
      break;
    }
    found ||= LETTER.test(char);
  }
  return found;
}

/**
 * Replace the userinfo that follows each `scheme://` with `***`, in one linear pass. Equivalent to
 * replacing `/([a-z][a-z0-9+.-]*:\/\/)USERINFO@/gi` with `$1***@`, where the end of USERINFO@ is
 * found by `userinfoEnd`.
 * @param text - Text that may hold URLs.
 * @param userinfoEnd - Given the text and the index after `://`, the index after the `@` that ends
 * the userinfo, or -1 when there is no userinfo there.
 * @returns The text with the userinfo of each URL replaced.
 * @example
 * ```ts
 * maskUserinfo('https://u:p@host', passwordUserinfoEnd); // 'https://***@host'
 * ```
 */
export function maskUserinfo(
  text: string,
  userinfoEnd: (text: string, from: number) => number,
): string {
  let result = '';
  let cursor = 0;
  let from = 0;
  for (;;) {
    const marker = text.indexOf('://', from);
    if (marker === -1) {
      return result + text.slice(cursor);
    }
    const end = hasSchemeBefore(text, marker)
      ? userinfoEnd(text, marker + 3)
      : -1;
    if (end === -1) {
      from = marker + 1;
    } else {
      result += `${text.slice(cursor, marker + 3)}***@`;
      cursor = end;
      from = end;
    }
  }
}

/**
 * The end of `[^\s/@]*@` at `from`: userinfo without a password, or with one.
 * @param text - The text being scanned.
 * @param from - Index after `://`.
 * @returns The index after the `@`, or -1.
 */
export function anyUserinfoEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && !/[\s/@]/.test(text.charAt(i))) {
    i += 1;
  }
  return text.charAt(i) === '@' ? i + 1 : -1;
}

/**
 * The end of `[^\s/@:]+@` at `from`: a token or user name without a password.
 * @param text - The text being scanned.
 * @param from - Index after `://`.
 * @returns The index after the `@`, or -1.
 */
function tokenUserinfoEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && !SEPARATOR.test(text.charAt(i))) {
    i += 1;
  }
  return i > from && text.charAt(i) === '@' ? i + 1 : -1;
}

/**
 * Make a finder for the end of `[^\s/@:]*:\S*@`: a user name, then a password that may hold `@` and
 * `/`, which runs to the last `@` before the next white space. The finder remembers the white space
 * delimited run it last measured, so repeated `://` in one long run cost one pass in all.
 * @returns A function to give to {@link maskUserinfo}; use one per text.
 */
function passwordUserinfoEnds(): (text: string, from: number) => number {
  let runEnd = -1;
  let lastAt = -1;
  return (text, from) => {
    let i = from;
    while (i < text.length && !SEPARATOR.test(text.charAt(i))) {
      i += 1;
    }
    if (text.charAt(i) !== ':') {
      return -1;
    }
    const start = i + 1;
    if (start >= runEnd) {
      runEnd = start;
      while (runEnd < text.length && !WHITESPACE.test(text.charAt(runEnd))) {
        runEnd += 1;
      }
      lastAt = text.lastIndexOf('@', runEnd - 1);
    }
    return lastAt >= start ? lastAt + 1 : -1;
  };
}
