import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/**
 * Computes the SHA-256 hex digest of a file's content.
 */
export async function sha256OfFile(filePath: string): Promise<string> {
  const b = await readFile(filePath);
  return createHash('sha256').update(b).digest('hex');
}
