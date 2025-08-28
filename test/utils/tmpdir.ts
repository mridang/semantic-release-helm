// utils/tmpdir.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Creates a new temporary directory under the OS temp root and returns
 * its absolute path. The directory is created synchronously and exists
 * when the function returns. A `prefix` helps group test artifacts.
 *
 * @param prefix Directory name prefix, e.g. "sr-".
 * @returns      Absolute path to the created temporary directory.
 */
export function makeTempDir(prefix = 'sr-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Wraps a test body so it runs inside an isolated temporary directory.
 * The directory is created before the test executes and removed after
 * the test finishes, regardless of success or failure.
 *
 * Usage with Jest (ESM):
 * ```ts
 * it('does something', withTempDir(async (base) => {
 *   // use base here
 * }));
 * ```
 *
 * @param fn Test body that receives the temp directory path.
 * @returns  A zero-arg async function suitable for a test runner.
 */
export function withTempDir(
  fn: (base: string) => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    const base = makeTempDir('sr-');
    try {
      await fn(base);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
}
