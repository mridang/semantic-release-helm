/**
 * @file Packages a Helm chart directory into a versioned .tgz archive and reports its digest.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A packaged chart: a `.tgz` file named `<name>-<version>.tgz`.
 */
/**
 * The chart name and version a package was made from.
 */
interface ChartIdentity {
  readonly name: string;
  readonly version: string;
}

export class ChartPackage {
  private readonly file: string;

  private readonly identity: ChartIdentity | undefined;

  /**
   * Wrap a packaged chart file, optionally with the chart identity it was made from.
   * @param file - Absolute path of the `.tgz`.
   * @param identity - The chart name and version, when known.
   * @example
   * ```ts
   * const pkg = ChartPackage.at('/repo/dist/charts/app-1.2.3.tgz');
   * ```
   */
  private constructor(file: string, identity?: ChartIdentity) {
    this.file = file;
    this.identity = identity;
  }

  /**
   * The package a chart produced. Its name and version come from the chart, not from the file name.
   * @param file - Absolute path of the `.tgz`.
   * @param name - The chart name as written in Chart.yaml.
   * @param version - The chart version as written in Chart.yaml.
   * @returns A package whose name and version come from the chart.
   * @example
   * ```ts
   * const pkg = ChartPackage.of('/repo/dist/charts/app-1.2.3.tgz', 'app', '1.2.3');
   * ```
   */
  static of(file: string, name: string, version: string): ChartPackage {
    return new ChartPackage(file, { name, version });
  }

  /**
   * Wrap a packaged chart file whose name and version are read from the file name.
   * @param file - Absolute path of the `.tgz`.
   * @returns A package that reads its identity from the file name.
   * @example
   * ```ts
   * const pkg = ChartPackage.at('/repo/dist/charts/app-1.2.3.tgz');
   * pkg.name; // 'app'
   * ```
   */
  static at(file: string): ChartPackage {
    return new ChartPackage(file);
  }

  /**
   * Find the packaged charts in a directory, sorted by file name. A missing directory yields none.
   * @param directory - Absolute path of the directory; it may not exist.
   * @returns The `.tgz` files in it, as packages.
   * @example
   * ```ts
   * const packages = ChartPackage.find('/repo/dist/charts');
   * packages.map((pkg) => pkg.fileName); // ['app-1.2.3.tgz']
   * ```
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
   * @returns The chart name, from the identity or the file name.
   */
  get name(): string {
    if (this.identity) {
      return this.identity.name;
    }
    return this.fileName.replace(/(-\d+\.\d+\.\d+)?\.tgz$/, '');
  }

  /**
   * The file name, such as `app-1.2.3.tgz`.
   * @returns The file name, including its extension.
   */
  get fileName(): string {
    return path.basename(this.file);
  }

  /**
   * The chart version: the one the package was made from, or the version in
   * the file name (`0.0.0` when it has none in the form `-1.2.3.tgz`).
   * @returns The chart version, from the identity or the file name.
   */
  get version(): string {
    if (this.identity) {
      return this.identity.version;
    }
    return /-(\d+\.\d+\.\d+)\.tgz$/.exec(this.fileName)?.[1] ?? '0.0.0';
  }

  /**
   * The path of the file relative to a base directory.
   * @param base - The directory the path is relative to, usually the repository root.
   * @returns The relative path.
   * @example
   * ```ts
   * const pkg = ChartPackage.at('/repo/dist/charts/app-1.2.3.tgz');
   * pkg.relativeTo('/repo'); // 'dist/charts/app-1.2.3.tgz'
   * ```
   */
  relativeTo(base: string): string {
    return path.relative(base, this.file);
  }

  /**
   * The SHA-256 digest of the packaged file, as published in index.yaml.
   * @returns The digest as lowercase hex.
   * @example
   * ```ts
   * const digest = ChartPackage.at('/repo/dist/charts/app-1.2.3.tgz').digest();
   * ```
   */
  digest(): string {
    return crypto
      .createHash('sha256')
      .update(fs.readFileSync(this.file))
      .digest('hex');
  }
}
