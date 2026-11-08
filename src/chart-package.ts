import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A packaged chart: a `.tgz` file named `<name>-<version>.tgz`.
 */
export class ChartPackage {
  private readonly file: string;

  private constructor(file: string) {
    this.file = file;
  }

  /**
   * Wrap a packaged chart file.
   *
   * @param file Absolute path of the `.tgz`.
   * @returns The package.
   */
  static at(file: string): ChartPackage {
    return new ChartPackage(file);
  }

  /**
   * Find the packaged charts in a directory.
   *
   * @param directory Absolute path of the directory; it may not exist.
   * @returns The `.tgz` files in it, as packages.
   */
  static find(directory: string): readonly ChartPackage[] {
    if (!fs.existsSync(directory)) {
      return [];
    }
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
      .map((entry) => new ChartPackage(path.join(directory, entry.name)));
  }

  /**
   * The absolute path of the file.
   *
   * @returns The path.
   */
  get path(): string {
    return this.file;
  }

  /**
   * The file name, such as `app-1.2.3.tgz`.
   *
   * @returns The name.
   */
  get fileName(): string {
    return path.basename(this.file);
  }

  /**
   * The version in the file name, or `0.0.0` when it has none in the form
   * `-1.2.3.tgz`.
   *
   * @returns The version.
   */
  get version(): string {
    return /-(\d+\.\d+\.\d+)\.tgz$/.exec(this.fileName)?.[1] ?? '0.0.0';
  }

  /**
   * The path of the file relative to a directory.
   *
   * @param base The directory, usually the repository root.
   * @returns The relative path.
   */
  relativeTo(base: string): string {
    return path.relative(base, this.file);
  }

  /**
   * The SHA-256 of the file.
   *
   * @returns The digest as hex.
   */
  digest(): string {
    return crypto
      .createHash('sha256')
      .update(fs.readFileSync(this.file))
      .digest('hex');
  }
}
