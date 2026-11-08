/**
 * Quote a shell argument for POSIX sh using single quotes. Embedded
 * single quotes are escaped by closing, inserting an escaped quote,
 * and reopening. The function performs no environment expansion.
 *
 * @param input The word to protect.
 * @returns The word wrapped in single quotes.
 */
export function shQuote(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a shell word only when it needs it. Words made solely of characters
 * the shell treats literally are left bare so logged commands stay readable.
 *
 * @param input The word to protect.
 * @returns The word, single-quoted unless it is already safe.
 */
export function quoteWord(input: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(input) ? input : shQuote(input);
}
