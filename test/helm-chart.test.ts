import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { HelmChart, ChartYaml } from '../src/helm-chart.js';
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
