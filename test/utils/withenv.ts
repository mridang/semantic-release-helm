/**
 * Run a function with a temporary set of environment variables and then
 * restore the original environment. Values set to `undefined` will be
 * removed for the duration of the call. The original `process.env` is
 * copied before applying overrides and restored in a `finally` block.
 *
 * The helper is intended for tests that must assert behavior across
 * different credential or configuration states without leaking those
 * changes between cases.
 *
 * @param env Key-value map of environment overrides to apply.
 * @param fn  Function executed while overrides are in effect.
 * @returns   The return value produced by the supplied function.
 */
export function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => T,
): T {
  const saved = { ...process.env };
  try {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'undefined') {
        delete (process.env as Record<string, string | undefined>)[key];
      } else {
        process.env[key] = value;
      }
    }
    return fn();
  } finally {
    process.env = saved;
  }
}
