import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A packaged chart: a `.tgz` file named `<name>-<version>.tgz`.
 */
export class ChartPackage {
  private readonly file: string;

  private readonly identity:
    { readonly name: string; readonly version: string } | undefined;

  /**
   * @param file - Absolute path of the `.tgz`.
   * @param identity - The chart name and version this package was made from,
   * when known; otherwise they are read from the file name.
   */
  private constructor(
    file: string,
    identity?: { readonly name: string; readonly version: string },
  ) {
    this.file = file;
    this.identity = identity;
  }

  /**
   * The package a chart produced. Its name and version come from the chart,
   * not from the file name.
   * @param file - Absolute path of the `.tgz`.
   * @param name - Chart name.
   * @param version - Chart version.
   * @returns The package.
   */
  static of(file: string, name: string, version: string): ChartPackage {
    return new ChartPackage(file, { name, version });
  }

  /**
   * Wrap a packaged chart file.
   * @param file - Absolute path of the `.tgz`.
   * @returns The package.
   */
  static at(file: string): ChartPackage {
    return new ChartPackage(file);
  }

  /**
   * Find the packaged charts in a directory.
   * @param directory - Absolute path of the directory; it may not exist.
   * @returns The `.tgz` files in it, as packages.
   */
  static find(directory: string): readonly ChartPackage[] {
    if (!fs.existsSync(directory)) {
      return [];
    }
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
      .map((entry) => entry.name)
      .toSorted()
      .map((name) => new ChartPackage(path.join(directory, name)));
  }

  /**
   * The chart name: the one the package was made from, or the file name
   * without its version.
   * @returns The name.
   */
  get name(): string {
    if (this.identity) {
      return this.identity.name;
    }
    return this.fileName.replace(/(-\d+\.\d+\.\d+)?\.tgz$/, '');
  }

  /**
   * The file name, such as `app-1.2.3.tgz`.
   * @returns The name.
   */
  get fileName(): string {
    return path.basename(this.file);
  }

  /**
   * The chart version: the one the package was made from, or the version in
   * the file name (`0.0.0` when it has none in the form `-1.2.3.tgz`).
   * @returns The version.
   */
  get version(): string {
    if (this.identity) {
      return this.identity.version;
    }
    return /-(\d+\.\d+\.\d+)\.tgz$/.exec(this.fileName)?.[1] ?? '0.0.0';
  }

  /**
   * The path of the file relative to a directory.
   * @param base - The directory, usually the repository root.
   * @returns The relative path.
   */
  relativeTo(base: string): string {
    return path.relative(base, this.file);
  }

  /**
   * The SHA-256 of the file.
   * @returns The digest as hex.
   */
  digest(): string {
    return crypto
      .createHash('sha256')
      .update(fs.readFileSync(this.file))
      .digest('hex');
  }
}
