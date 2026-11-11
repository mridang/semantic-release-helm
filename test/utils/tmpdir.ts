// utils/tmpdir.ts
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Creates a new temporary directory under the OS temp root and returns
 * its absolute path. The directory is created before the promise resolves.
 * A `prefix` helps group test artifacts.
 * @param prefix - Directory name prefix, e.g. "sr-".
 * @returns Absolute path to the created temporary directory.
 */
async function makeTempDir(prefix = 'sr-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Wraps a test body so it runs inside an isolated temporary directory.
 * The directory is created before the test executes and removed after
 * the test finishes, regardless of success or failure.
 *
 * Usage with Jest (ESM):.
 * ```ts
 * it('does something', withTempDir(async (base) => {
 *   // use base here
 * }));
 * ```
 * @param fn - Test body that receives the temp directory path.
 * @returns A zero-arg async function suitable for a test runner.
 */
export function withTempDir(
  fn: (base: string) => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    const base = await makeTempDir('sr-');
    try {
      await fn(base);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  };
}
