import { access, copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

export const pathExists = (path: string): Promise<boolean> =>
  access(path)
    .then(() => true)
    .catch(() => false);

/**
 * Copy a directory tree. A stable stand-in for `fs.cp`, which is experimental
 * before Node 22.3.
 * @param source - Directory to copy.
 * @param destination - Directory to create.
 */
export async function copyDirectory(
  source: string,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const from = path.join(source, entry.name);
      const to = path.join(destination, entry.name);
      await (entry.isDirectory()
        ? copyDirectory(from, to)
        : copyFile(from, to));
    }),
  );
}
