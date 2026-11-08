import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { HelmChart, ChartYaml, setChartVersion } from '../src/helm-chart.js';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { withTempDir } from './utils/tmpdir.js';

const FIXED_TIME = new Date('2001-01-02T03:04:05.000Z');

function writeChart(
  dir: string,
  name: string,
  version: string,
  extra?: Record<string, unknown>,
): string {
  const chartDir = path.join(dir, name);
  fs.mkdirSync(chartDir, { recursive: true });
  const chartFile = path.join(chartDir, 'Chart.yaml');
  const doc = yaml.stringify({
    apiVersion: 'v2',
    name,
    version,
    description: 'X',
    ...(extra ?? {}),
  } as ChartYaml);
  fs.writeFileSync(chartFile, doc, 'utf8');
  return chartDir;
}

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(FIXED_TIME);
});

afterAll(() => {
  jest.useRealTimers();
});

describe('HelmChart', () => {
  /**
   * Loads name and version from Chart.yaml to ensure the parser extracts
   * required core fields correctly and exposes them via accessors.
   */
  it(
    'loads name and version',
    withTempDir((base: string) => {
      const chartDir = writeChart(base, 'demo', '1.2.3');
      const chart = HelmChart.from(chartDir);
      expect({ name: chart.name(), version: chart.version() }).toEqual({
        name: 'demo',
        version: '1.2.3',
      });
    }),
  );

  /**
   * Ensures immutability when changing versions. A new instance must be
   * returned while the original instance remains unchanged.
   */
  it(
    'creates new instance on version change',
    withTempDir((base: string) => {
      const c1 = HelmChart.from(writeChart(base, 'demo', '1.0.0'));
      const c2 = c1.withVersion('1.1.0');
      expect({ old: c1.version(), newer: c2.version() }).toEqual({
        old: '1.0.0',
        newer: '1.1.0',
      });
    }),
  );

  /**
   * Saves YAML after mutation and preserves unknown keys so that forward
   * compatibility with future Chart.yaml fields is maintained.
   */
  it(
    'saves YAML and preserves unknown fields',
    withTempDir((base: string) => {
      const dir = writeChart(base, 'demo', '0.1.0', {
        keywords: ['a', 'b'],
        icon: 'https://x/icon.svg',
        'x-future': { ok: true },
      });
      const file = path.join(dir, 'Chart.yaml');
      HelmChart.from(dir).withVersion('0.2.0').saveTo(file);
      expect(yaml.parse(fs.readFileSync(file, 'utf8')) as ChartYaml).toEqual({
        apiVersion: 'v2',
        name: 'demo',
        version: '0.2.0',
        description: 'X',
        keywords: ['a', 'b'],
        icon: 'https://x/icon.svg',
        'x-future': { ok: true },
      });
    }),
  );

  /**
   * Emits valid YAML text that round-trips to a structured object containing
   * the expected core fields without lossy transformations.
   */
  it(
    'emits valid YAML via toYAML',
    withTempDir((base: string) => {
      const chart = HelmChart.from(writeChart(base, 'demo', '9.9.9'));
      expect(yaml.parse(chart.toYAML()) as ChartYaml).toEqual({
        apiVersion: 'v2',
        name: 'demo',
        version: '9.9.9',
        description: 'X',
      });
    }),
  );

  /**
   * Returns a shallow copy of the parsed structure. External mutations to the
   * returned object must not affect the internal state of the instance.
   */
  it(
    'returns shallow copy from raw',
    withTempDir((base: string) => {
      const chart = HelmChart.from(writeChart(base, 'demo', '1.0.0', { a: 1 }));
      const r1 = chart.raw();
      (r1 as Record<string, unknown>).a = 2;
      expect(chart.raw()).toEqual({
        apiVersion: 'v2',
        name: 'demo',
        version: '1.0.0',
        description: 'X',
        a: 1,
      });
    }),
  );
});

describe('HelmChart.from with unusual Chart.yaml content', () => {
  it(
    'stringifies a numeric name, version and apiVersion',
    withTempDir((base: string) => {
      const dir = path.join(base, 'odd');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'Chart.yaml'),
        'name: 7\nversion: 1.5\napiVersion: 2\n',
        'utf8',
      );
      const chart = HelmChart.from(dir);
      expect({
        name: chart.name(),
        version: chart.version(),
        apiVersion: chart.apiVersion(),
      }).toEqual({ name: '7', version: '1.5', apiVersion: '2' });
    }),
  );

  it.each([
    ['an empty file', ''],
    ['a non-mapping file', '- a\n- b\n'],
  ])('treats %s as an empty chart', (_label, content) =>
    withTempDir((base: string) => {
      const dir = path.join(base, 'empty');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'Chart.yaml'), content, 'utf8');
      const chart = HelmChart.from(dir);
      expect({
        name: chart.name(),
        version: chart.version(),
        apiVersion: chart.apiVersion(),
      }).toEqual({ name: '', version: undefined, apiVersion: undefined });
    })(),
  );
});

describe('setChartVersion', () => {
  it('replaces the version and keeps every other field', () => {
    const out = setChartVersion(
      'apiVersion: v2\nname: demo\nversion: 0.1.0\nkeywords:\n  - a\n',
      '2.0.0',
    );
    expect(yaml.parse(out)).toEqual({
      apiVersion: 'v2',
      name: 'demo',
      version: '2.0.0',
      keywords: ['a'],
    });
  });

  it('keeps comments, quoting and blank lines', () => {
    const out = setChartVersion(
      '# my chart\napiVersion: v2\nname: "demo"\n\nversion: 0.1.0 # bumped by CI\n',
      '2.0.0',
    );
    expect(out).toBe(
      '# my chart\napiVersion: v2\nname: "demo"\n\nversion: 2.0.0 # bumped by CI\n',
    );
  });

  it('adds a version when the mapping has none', () => {
    expect(yaml.parse(setChartVersion('name: demo\n', '1.0.0'))).toEqual({
      name: 'demo',
      version: '1.0.0',
    });
  });

  it.each([
    ['empty', ''],
    ['a list', '- a\n'],
    ['a scalar', 'just text\n'],
  ])('refuses a Chart.yaml that is %s', (_label, content) => {
    expect(() => setChartVersion(content, '1.0.0')).toThrow(
      expect.objectContaining({ code: 'EINVALIDCHARTYAML' }),
    );
  });

  it('rethrows a YAML syntax error', () => {
    expect(() => setChartVersion('a: [\n', '1.0.0')).toThrow();
  });
});
