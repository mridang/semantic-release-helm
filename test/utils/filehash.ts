import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * Computes the SHA-256 hex digest of a file's content.
 */
export function sha256OfFile(filePath: string): string {
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, its callers build expectations synchronously
  const b = readFileSync(filePath);
  return createHash('sha256').update(b).digest('hex');
}
