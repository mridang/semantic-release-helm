import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { HelmChart } from '../src/helm-chart.js';
import { HelmIndex, ChartEntry, HelmIndexDoc } from '../src/helm-index.js';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { withTempDir } from './utils/tmpdir.js';
import { sha256OfFile } from './utils/filehash.js';

const FIXED_TIME = new Date('2001-01-02T03:04:05.000Z');
const FIXED_ISO = FIXED_TIME.toISOString();

function writeChartYaml(
  dir: string,
  name: string,
  version: string,
  extra?: Record<string, unknown>,
): string {
  const chartDir = path.join(dir, 'charts', name);
  fs.mkdirSync(chartDir, { recursive: true });
  const chartFile = path.join(chartDir, 'Chart.yaml');
  const doc = yaml.stringify({
    apiVersion: 'v2',
    name,
    version,
    description: 'X',
    ...(extra ?? {}),
  });
  fs.writeFileSync(chartFile, doc, 'utf8');
  return chartDir;
}

function writeTgz(
  dir: string,
  name: string,
  version: string,
  content: string,
): string {
  const tgz = path.join(dir, 'dist', 'charts', `${name}-${version}.tgz`);
  fs.mkdirSync(path.dirname(tgz), { recursive: true });
  fs.writeFileSync(tgz, content, 'utf8');
  return tgz;
}

function readIndex(idxPath: string): HelmIndexDoc {
  return yaml.parse(fs.readFileSync(idxPath, 'utf8')) as HelmIndexDoc;
}

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(FIXED_TIME);
});

afterAll(() => {
  jest.useRealTimers();
});

describe('HelmIndex', () => {
  /**
   * Creates a new index file when none exists and ensures the minimal valid
   * structure is persisted with apiVersion v1 and empty entries map.
   */
  it(
    'initializes empty index on first write',
    withTempDir((base: string) => {
      const idxPath = path.join(base, 'charts', 'index.yaml');
      HelmIndex.fromFile(idxPath).writeTo(idxPath);
      expect(readIndex(idxPath)).toEqual({ apiVersion: 'v1', entries: {} });
    }),
  );

  /**
   * Appends entries across releases, preserving prior versions and ordering
   * newest first. Verifies digest, created, urls, and passthrough fields.
   */
  it(
    'appends versions and keeps newest first',
    withTempDir((base: string) => {
      const idxPath = path.join(base, 'charts', 'index.yaml');
      const c100 = HelmChart.from(writeChartYaml(base, 'dummy', '1.0.0'));
      const t100 = writeTgz(base, 'dummy', '1.0.0', 'a');
      HelmIndex.fromFile(idxPath)
        .append(c100, t100, 'https://example.test/charts', {
          appVersion: '1.0.0',
        })
        .writeTo(idxPath);

      const c110 = c100.withVersion('1.1.0');
      const t110 = writeTgz(base, 'dummy', '1.1.0', 'b');
      HelmIndex.fromFile(idxPath)
        .append(c110, t110, 'https://example.test/charts')
        .writeTo(idxPath);

      expect(readIndex(idxPath)).toEqual({
        apiVersion: 'v1',
        generated: FIXED_ISO,
        entries: {
          dummy: [
            {
              apiVersion: 'v2',
              name: 'dummy',
              version: '1.1.0',
              created: FIXED_ISO,
              digest: sha256OfFile(t110),
              urls: ['https://example.test/charts/dummy-1.1.0.tgz'],
              description: 'X',
            } as ChartEntry,
            {
              apiVersion: 'v2',
              name: 'dummy',
              version: '1.0.0',
              created: FIXED_ISO,
              digest: sha256OfFile(t100),
              urls: ['https://example.test/charts/dummy-1.0.0.tgz'],
              description: 'X',
              appVersion: '1.0.0',
            } as ChartEntry,
          ],
        },
      });
    }),
  );

  /**
   * Replaces an existing version rather than duplicating it. Ensures digest
   * and urls reflect the latest artifact for that version.
   */
  it(
    'replaces same version without duplication',
    withTempDir((base: string) => {
      const idxPath = path.join(base, 'charts', 'index.yaml');
      const chart = HelmChart.from(writeChartYaml(base, 'demo', '2.0.0'));

      const t1 = writeTgz(base, 'demo', '2.0.0', 'first');
      HelmIndex.fromFile(idxPath)
        .append(chart, t1, 'https://u.test/charts')
        .writeTo(idxPath);

      const t2 = writeTgz(base, 'demo', '2.0.0', 'second');
      HelmIndex.fromFile(idxPath)
        .append(chart, t2, 'https://u.test/charts')
        .writeTo(idxPath);

      expect(readIndex(idxPath)).toEqual({
        apiVersion: 'v1',
        generated: FIXED_ISO,
        entries: {
          demo: [
            {
              apiVersion: 'v2',
              name: 'demo',
              version: '2.0.0',
              created: FIXED_ISO,
              digest: sha256OfFile(t2),
              urls: ['https://u.test/charts/demo-2.0.0.tgz'],
              description: 'X',
            },
          ],
        },
      });
    }),
  );

  /**
   * Sorts entries using semantic version order so that higher versions are
   * listed before lower ones within a chart name group.
   */
  it(
    'sorts entries by semver descending',
    withTempDir((base: string) => {
      const idxPath = path.join(base, 'charts', 'index.yaml');
      const c100 = HelmChart.from(writeChartYaml(base, 'svc', '1.0.0'));
      const t100 = writeTgz(base, 'svc', '1.0.0', 'x');
      HelmIndex.empty()
        .append(c100, t100, 'https://ex.test/charts')
        .writeTo(idxPath);

      const c200 = c100.withVersion('2.0.0');
      const t200 = writeTgz(base, 'svc', '2.0.0', 'y');
      HelmIndex.fromFile(idxPath)
        .append(c200, t200, 'https://ex.test/charts')
        .writeTo(idxPath);

      expect(readIndex(idxPath)).toEqual({
        apiVersion: 'v1',
        generated: FIXED_ISO,
        entries: {
          svc: [
            {
              apiVersion: 'v2',
              name: 'svc',
              version: '2.0.0',
              created: FIXED_ISO,
              digest: sha256OfFile(t200),
              urls: ['https://ex.test/charts/svc-2.0.0.tgz'],
              description: 'X',
            },
            {
              apiVersion: 'v2',
              name: 'svc',
              version: '1.0.0',
              created: FIXED_ISO,
              digest: sha256OfFile(t100),
              urls: ['https://ex.test/charts/svc-1.0.0.tgz'],
              description: 'X',
            },
          ],
        },
      });
    }),
  );

  /**
   * Writes URLs in absolute or relative form based on presence of a base URL.
   * Ensures relative mode writes only the filename.
   */
  it(
    'writes absolute or relative urls',
    withTempDir((base: string) => {
      const idxPath = path.join(base, 'charts', 'index.yaml');
      const chart = HelmChart.from(writeChartYaml(base, 'web', '3.1.4'));
      const tgz = writeTgz(base, 'web', '3.1.4', 'content');

      HelmIndex.fromFile(idxPath).append(chart, tgz, '').writeTo(idxPath);
      expect(readIndex(idxPath)).toEqual({
        apiVersion: 'v1',
        generated: FIXED_ISO,
        entries: {
          web: [
            {
              apiVersion: 'v2',
              name: 'web',
              version: '3.1.4',
              created: FIXED_ISO,
              digest: sha256OfFile(tgz),
              urls: ['web-3.1.4.tgz'],
              description: 'X',
            },
          ],
        },
      });

      HelmIndex.fromFile(idxPath)
        .append(
          chart.withVersion('3.1.5'),
          writeTgz(base, 'web', '3.1.5', 'c'),
          'https://repo.test/charts',
        )
        .writeTo(idxPath);

      const parsed = readIndex(idxPath);
      expect(parsed.entries.web[0]).toEqual({
        apiVersion: 'v2',
        name: 'web',
        version: '3.1.5',
        created: FIXED_ISO,
        digest: sha256OfFile(
          path.join(base, 'dist', 'charts', 'web-3.1.5.tgz'),
        ),
        urls: ['https://repo.test/charts/web-3.1.5.tgz'],
        description: 'X',
      });
    }),
  );

  /**
   * Passes through metadata from Chart.yaml and coerces appVersion to string.
   * Ensures unknown keys are preserved unchanged.
   */
  it(
    'passes metadata and coerces appVersion',
    withTempDir((base: string) => {
      const idxPath = path.join(base, 'charts', 'index.yaml');
      const chart = HelmChart.from(
        writeChartYaml(base, 'api', '0.9.0', {
          appVersion: 42,
          icon: 'https://i/icon.svg',
          keywords: ['k1', 'k2'],
          maintainers: [{ name: 'a', email: 'a@x' }],
          kubeVersion: '>=1.24.0-0',
          type: 'application',
          'x-future': { nested: true },
        }),
      );
      const tgz = writeTgz(base, 'api', '0.9.0', 'z');

      HelmIndex.fromFile(idxPath)
        .append(chart, tgz, 'https://r.test/c')
        .writeTo(idxPath);

      expect(readIndex(idxPath)).toEqual({
        apiVersion: 'v1',
        generated: FIXED_ISO,
        entries: {
          api: [
            {
              apiVersion: 'v2',
              name: 'api',
              version: '0.9.0',
              created: FIXED_ISO,
              digest: sha256OfFile(tgz),
              urls: ['https://r.test/c/api-0.9.0.tgz'],
              description: 'X',
              appVersion: '42',
              icon: 'https://i/icon.svg',
              keywords: ['k1', 'k2'],
              kubeVersion: '>=1.24.0-0',
              type: 'application',
              maintainers: [{ name: 'a', email: 'a@x' }],
              'x-future': { nested: true },
            } as ChartEntry,
          ],
        },
      });
    }),
  );

  /**
   * Ensures Chart.yaml cannot override reserved fields that are computed at
   * index time, including urls, digest, and created timestamp.
   */
  it(
    'denylists computed fields from override',
    withTempDir((base: string) => {
      const idxPath = path.join(base, 'charts', 'index.yaml');
      const chart = HelmChart.from(
        writeChartYaml(base, 'svc', '7.7.7', {
          urls: ['http://bad/url.tgz'],
          created: '1999-01-01T00:00:00.000Z',
          digest: 'deadbeef',
        }),
      );
      const tgz = writeTgz(base, 'svc', '7.7.7', 'payload');

      HelmIndex.fromFile(idxPath)
        .append(chart, tgz, 'https://good/charts')
        .writeTo(idxPath);

      expect(readIndex(idxPath)).toEqual({
        apiVersion: 'v1',
        generated: FIXED_ISO,
        entries: {
          svc: [
            {
              apiVersion: 'v2',
              name: 'svc',
              version: '7.7.7',
              created: FIXED_ISO,
              digest: sha256OfFile(tgz),
              urls: ['https://good/charts/svc-7.7.7.tgz'],
              description: 'X',
            },
          ],
        },
      });
    }),
  );

  /**
   * Writes a stable generated timestamp and preserves apiVersion v1 across a
   * load → write cycle, ensuring idempotent serialization.
   */
  it(
    'writes generated and stays idempotent',
    withTempDir((base: string) => {
      const idxPath = path.join(base, 'charts', 'index.yaml');
      const chart = HelmChart.from(writeChartYaml(base, 'clock', '1.0.0'));
      const tgz = writeTgz(base, 'clock', '1.0.0', 't');

      HelmIndex.fromFile(idxPath).append(chart, tgz, '').writeTo(idxPath);
      const first = readIndex(idxPath);

      HelmIndex.fromFile(idxPath).writeTo(idxPath);
      const second = readIndex(idxPath);

      expect(first).toEqual({
        apiVersion: 'v1',
        generated: FIXED_ISO,
        entries: {
          clock: [
            {
              apiVersion: 'v2',
              name: 'clock',
              version: '1.0.0',
              created: FIXED_ISO,
              digest: sha256OfFile(tgz),
              urls: ['clock-1.0.0.tgz'],
              description: 'X',
            },
          ],
        },
      });
      expect(second).toEqual(first);
    }),
  );
});
