import * as fs from 'node:fs';
import * as crypto from 'crypto';

/**
 * Computes the SHA-256 hex digest of a file's content.
 */
export function sha256OfFile(filePath: string): string {
  const b = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(b).digest('hex');
}
