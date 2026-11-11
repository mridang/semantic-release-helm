import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { ChartPackage } from '../src/chart-package.js';
import { withTempDir } from './utils/tmpdir.js';

describe('ChartPackage', () => {
  it('takes its identity from the chart when it was made from one', () => {
    const pkg = ChartPackage.of('/r/x.tgz', 'app', '1.0.0-beta.1');
    expect(pkg.name).toBe('app');
    expect(pkg.version).toBe('1.0.0-beta.1');
  });

  it('reads the version and file name from the file name', () => {
    const pkg = ChartPackage.at('/r/dist/charts/app-1.2.3.tgz');
    expect(pkg.fileName).toBe('app-1.2.3.tgz');
    expect(pkg.version).toBe('1.2.3');
    expect(pkg.name).toBe('app');
    expect(pkg.relativeTo('/r')).toBe(
      path.join('dist', 'charts', 'app-1.2.3.tgz'),
    );
  });

  it('falls back to 0.0.0 when the name has no plain version', () => {
    expect(ChartPackage.at('/x/app-1.0.0-beta.1.tgz').version).toBe('0.0.0');
    expect(ChartPackage.at('/x/app.tgz').version).toBe('0.0.0');
  });

  it(
    'hashes the file content',
    withTempDir(async (dir) => {
      const file = path.join(dir, 'app-1.0.0.tgz');
      await fs.writeFile(file, 'content');
      expect(await ChartPackage.at(file).digest()).toBe(
        crypto.createHash('sha256').update('content').digest('hex'),
      );
    }),
  );

  it(
    'finds only the .tgz files of a directory',
    withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'b-1.0.0.tgz'), 'b');
      await fs.writeFile(path.join(dir, 'a-1.0.0.tgz'), 'a');
      await fs.writeFile(path.join(dir, 'index.yaml'), 'x');
      await fs.mkdir(path.join(dir, 'b-2.0.0.tgz'));
      const found = await ChartPackage.find(path.resolve(dir));
      expect(found.map((p) => p.fileName)).toEqual([
        'a-1.0.0.tgz',
        'b-1.0.0.tgz',
      ]);
    }),
  );

  it('finds nothing in a directory that does not exist', async () => {
    expect(await ChartPackage.find('/nonexistent-dir-for-test')).toEqual([]);
  });
});
