import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { Chart } from '../src/chart.js';
import { ChartPackage } from '../src/chart-package.js';
import { ChartRepository, ChartEntry } from '../src/chart-repository.js';
import { DockerImage } from '../src/docker.js';
import { fakeRunner, recordingLogger } from './utils/runner.js';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { withTempDir } from './utils/tmpdir.js';
import { sha256OfFile } from './utils/filehash.js';

/** A chart in a directory, with images that are never run. */
function chartAt(dir: string): Chart {
  const { run } = fakeRunner();
  const { logger } = recordingLogger();
  const image = new DockerImage({ image: 'unused', logger, cwd: dir, run });
  return Chart.open({
    directory: '',
    cwd: dir,
    logger,
    run,
    helm: image,
    docs: image,
  });
}

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

interface ChartRepositoryDoc {
  apiVersion: 'v1';
  entries: Record<string, ChartEntry[]>;
  generated?: string;
}

function readIndex(idxPath: string): ChartRepositoryDoc {
  return yaml.parse(fs.readFileSync(idxPath, 'utf8')) as ChartRepositoryDoc;
}

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(FIXED_TIME);
});

afterAll(() => {
  jest.useRealTimers();
});

describe('ChartRepository', () => {
  /**
   * Creates a new index file when none exists and ensures the minimal valid
   * structure is persisted with apiVersion v1 and empty entries map.
   */
  it(
    'initializes empty index on first write',
    withTempDir((base: string) => {
      const idxPath = path.join(base, 'charts', 'index.yaml');
      ChartRepository.open(path.dirname(idxPath)).save();
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
      const c100 = chartAt(writeChartYaml(base, 'dummy', '1.0.0'));
      const t100 = writeTgz(base, 'dummy', '1.0.0', 'a');
      ChartRepository.open(path.dirname(idxPath))
        .add(c100, ChartPackage.at(t100), 'https://example.test/charts', {
          appVersion: '1.0.0',
        })
        .save();

      const c110 = c100.withVersion('1.1.0');
      const t110 = writeTgz(base, 'dummy', '1.1.0', 'b');
      ChartRepository.open(path.dirname(idxPath))
        .add(c110, ChartPackage.at(t110), 'https://example.test/charts')
        .save();

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
      const chart = chartAt(writeChartYaml(base, 'demo', '2.0.0'));

      const t1 = writeTgz(base, 'demo', '2.0.0', 'first');
      ChartRepository.open(path.dirname(idxPath))
        .add(chart, ChartPackage.at(t1), 'https://u.test/charts')
        .save();

      const t2 = writeTgz(base, 'demo', '2.0.0', 'second');
      ChartRepository.open(path.dirname(idxPath))
        .add(chart, ChartPackage.at(t2), 'https://u.test/charts')
        .save();

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
      const c100 = chartAt(writeChartYaml(base, 'svc', '1.0.0'));
      const t100 = writeTgz(base, 'svc', '1.0.0', 'x');
      ChartRepository.open(path.dirname(idxPath))
        .add(c100, ChartPackage.at(t100), 'https://ex.test/charts')
        .save();

      const c200 = c100.withVersion('2.0.0');
      const t200 = writeTgz(base, 'svc', '2.0.0', 'y');
      ChartRepository.open(path.dirname(idxPath))
        .add(c200, ChartPackage.at(t200), 'https://ex.test/charts')
        .save();

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
      const chart = chartAt(writeChartYaml(base, 'web', '3.1.4'));
      const tgz = writeTgz(base, 'web', '3.1.4', 'content');

      ChartRepository.open(path.dirname(idxPath))
        .add(chart, ChartPackage.at(tgz), '')
        .save();
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

      ChartRepository.open(path.dirname(idxPath))
        .add(
          chart.withVersion('3.1.5'),
          ChartPackage.at(writeTgz(base, 'web', '3.1.5', 'c')),
          'https://repo.test/charts',
        )
        .save();

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
      const chart = chartAt(
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

      ChartRepository.open(path.dirname(idxPath))
        .add(chart, ChartPackage.at(tgz), 'https://r.test/c')
        .save();

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
      const chart = chartAt(
        writeChartYaml(base, 'svc', '7.7.7', {
          urls: ['http://bad/url.tgz'],
          created: '1999-01-01T00:00:00.000Z',
          digest: 'deadbeef',
        }),
      );
      const tgz = writeTgz(base, 'svc', '7.7.7', 'payload');

      ChartRepository.open(path.dirname(idxPath))
        .add(chart, ChartPackage.at(tgz), 'https://good/charts')
        .save();

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
      const chart = chartAt(writeChartYaml(base, 'clock', '1.0.0'));
      const tgz = writeTgz(base, 'clock', '1.0.0', 't');

      ChartRepository.open(path.dirname(idxPath))
        .add(chart, ChartPackage.at(tgz), '')
        .save();
      const first = readIndex(idxPath);

      ChartRepository.open(path.dirname(idxPath)).save();
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

describe('ChartRepository load, append and write of unusual index.yaml content', () => {
  it(
    'keeps unknown top-level keys, odd items and non-list chart keys through append',
    withTempDir((base: string) => {
      const file = path.join(base, 'index.yaml');
      fs.writeFileSync(
        file,
        yaml.stringify({
          apiVersion: 'v9',
          annotations: { team: 'platform' },
          entries: {
            other: [{ name: 'other', version: 2 }, 'junk', null],
            nul: null,
            mapping: { a: 1 },
          },
        }),
        'utf8',
      );
      const chart = chartAt(writeChartYaml(base, 'demo', '1.0.0'));
      const tgz = writeTgz(base, 'demo', '1.0.0', 'x');
      const out = path.join(base, 'index.yaml');
      ChartRepository.open(path.dirname(file))
        .add(chart, ChartPackage.at(tgz), '')
        .save();
      const doc = yaml.parse(fs.readFileSync(out, 'utf8'));
      expect(doc.apiVersion).toBe('v1');
      expect(doc.annotations).toEqual({ team: 'platform' });
      expect(doc.entries.other).toEqual([
        { name: 'other', version: 2 },
        'junk',
        null,
      ]);
      expect(doc.entries.nul).toBeNull();
      expect(doc.entries.mapping).toEqual({ a: 1 });
      expect(doc.entries.demo).toHaveLength(1);
    }),
  );

  it.each([
    ['a mapping', 'entries:\n  demo:\n    a: 1\n'],
    ['a scalar', 'entries:\n  demo: nope\n'],
  ])('refuses to append over a chart key that is %s', (_label, content) =>
    withTempDir((base: string) => {
      const file = path.join(base, 'index.yaml');
      fs.writeFileSync(file, content, 'utf8');
      const chart = chartAt(writeChartYaml(base, 'demo', '1.0.0'));
      const tgz = writeTgz(base, 'demo', '1.0.0', 'x');
      expect(() =>
        ChartRepository.open(path.dirname(file)).add(
          chart,
          ChartPackage.at(tgz),
          '',
        ),
      ).toThrow(expect.objectContaining({ code: 'EINVALIDINDEX' }));
    })(),
  );

  it.each([
    ['null', 'entries: null\n'],
    ['absent', 'apiVersion: v1\n'],
    ['a null chart key', 'entries:\n  demo: null\n'],
  ])('treats %s as empty', (_label, content) =>
    withTempDir((base: string) => {
      const file = path.join(base, 'index.yaml');
      fs.writeFileSync(file, content, 'utf8');
      const chart = chartAt(writeChartYaml(base, 'demo', '1.0.0'));
      const tgz = writeTgz(base, 'demo', '1.0.0', 'x');
      const out = path.join(base, 'index.yaml');
      ChartRepository.open(path.dirname(file))
        .add(chart, ChartPackage.at(tgz), '')
        .save();
      expect(readIndex(out).entries.demo).toHaveLength(1);
    })(),
  );

  it.each([
    ['a list', 'entries:\n  - a\n'],
    ['a string', 'entries: nope\n'],
  ])('refuses an index whose entries is %s', (_label, content) =>
    withTempDir((base: string) => {
      const file = path.join(base, 'index.yaml');
      fs.writeFileSync(file, content, 'utf8');
      expect(() => ChartRepository.open(path.dirname(file))).toThrow(
        expect.objectContaining({ code: 'EINVALIDINDEX' }),
      );
    })(),
  );

  it(
    'yields an empty index for an empty file',
    withTempDir((base: string) => {
      const file = path.join(base, 'index.yaml');
      const out = path.join(base, 'index.yaml');
      fs.writeFileSync(file, '', 'utf8');
      ChartRepository.open(path.dirname(file)).save();
      expect(readIndex(out)).toEqual({ apiVersion: 'v1', entries: {} });
    }),
  );

  it(
    'refuses to replace an index that is not a mapping',
    withTempDir((base: string) => {
      const file = path.join(base, 'index.yaml');
      fs.writeFileSync(file, '- a\n- b\n', 'utf8');
      expect(() => ChartRepository.open(path.dirname(file))).toThrow(
        expect.objectContaining({ code: 'EINVALIDINDEX' }),
      );
    }),
  );
});

describe('ChartRepository.append with unusual chart names', () => {
  it(
    'handles a chart named after an Object.prototype member',
    withTempDir((base: string) => {
      const chart = chartAt(writeChartYaml(base, 'constructor', '1.0.0'));
      const tgz = writeTgz(base, 'constructor', '1.0.0', 'x');
      const out = path.join(base, 'index.yaml');
      ChartRepository.open(path.dirname(out))
        .add(chart, ChartPackage.at(tgz), '')
        .save();
      const written = yaml.parse(fs.readFileSync(out, 'utf8'));
      expect(
        written.entries.constructor.map((e: ChartEntry) => e.version),
      ).toEqual(['1.0.0']);
    }),
  );
});

describe('ChartRepository key order', () => {
  it(
    'writes apiVersion, entries, other keys, then generated',
    withTempDir((base: string) => {
      const file = path.join(base, 'index.yaml');
      fs.writeFileSync(
        file,
        'generated: old\nannotations:\n  a: b\nentries: {}\n',
        'utf8',
      );
      const chart = chartAt(writeChartYaml(base, 'demo', '1.0.0'));
      const tgz = writeTgz(base, 'demo', '1.0.0', 'x');
      const out = path.join(base, 'index.yaml');
      ChartRepository.open(path.dirname(file))
        .add(chart, ChartPackage.at(tgz), '')
        .save();
      expect(Object.keys(yaml.parse(fs.readFileSync(out, 'utf8')))).toEqual([
        'apiVersion',
        'entries',
        'annotations',
        'generated',
      ]);
    }),
  );
});

describe('ChartRepository YAML handling', () => {
  it(
    'turns a YAML syntax error into a coded error that names the file',
    withTempDir((base: string) => {
      const file = path.join(base, 'index.yaml');
      fs.writeFileSync(file, 'a: 1\n---\nb: 2\n', 'utf8');
      expect(() => ChartRepository.open(path.dirname(file))).toThrow(
        expect.objectContaining({
          code: 'EINVALIDINDEX',
          details: expect.stringContaining('index.yaml'),
        }),
      );
    }),
  );

  it(
    'writes long descriptions on one line, like Chart.yaml',
    withTempDir((base: string) => {
      const description = 'word '.repeat(40).trim();
      const chart = chartAt(
        writeChartYaml(base, 'demo', '1.0.0', { description }),
      );
      const tgz = writeTgz(base, 'demo', '1.0.0', 'x');
      const out = path.join(base, 'index.yaml');
      ChartRepository.open(path.dirname(out))
        .add(chart, ChartPackage.at(tgz), '')
        .save();
      expect(fs.readFileSync(out, 'utf8')).toContain(
        `description: ${description}\n`,
      );
    }),
  );
});
