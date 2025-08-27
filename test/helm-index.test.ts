import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { HelmChart } from '../src/helm-chart.js';
import { HelmIndex, ChartEntry, HelmIndexDoc } from '../src/helm-index.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function tmpdir(): string {
  const d = path.join(__dirname, `.tmp-index-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeChartYaml(dir: string, name: string, version: string): string {
  const chartDir = path.join(dir, 'charts', name);
  fs.mkdirSync(chartDir, { recursive: true });
  const chartFile = path.join(chartDir, 'Chart.yaml');
  const doc = yaml.stringify({
    apiVersion: 'v2',
    name,
    version,
    description: 'X',
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

describe('HelmIndex', () => {
  it('starts empty when file does not exist', () => {
    const base = tmpdir();
    const idxPath = path.join(base, 'charts', 'index.yaml');
    const index = HelmIndex.fromFile(idxPath);
    index.writeTo(idxPath);
    const raw = fs.readFileSync(idxPath, 'utf8');
    const parsed = yaml.parse(raw) as HelmIndexDoc;
    expect(parsed).toEqual({
      apiVersion: 'v1',
      entries: {},
    });
  });

  it('append creates entry and preserves subsequent versions', () => {
    const base = tmpdir();
    const chartDir = writeChartYaml(base, 'dummy', '1.0.0');
    const chart100 = HelmChart.from(chartDir);
    const tgz100 = writeTgz(base, 'dummy', '1.0.0', 'a');
    const idxPath = path.join(base, 'charts', 'index.yaml');

    const i0 = HelmIndex.fromFile(idxPath);
    const i1 = i0.append(chart100, tgz100, 'https://example.test/charts', {
      appVersion: '1.0.0',
    });
    i1.writeTo(idxPath);

    const chart110 = chart100.withVersion('1.1.0');
    const tgz110 = writeTgz(base, 'dummy', '1.1.0', 'b');

    const i2 = HelmIndex.fromFile(idxPath);
    const i3 = i2.append(chart110, tgz110, 'https://example.test/charts');
    i3.writeTo(idxPath);

    const raw = fs.readFileSync(idxPath, 'utf8');
    const parsed = yaml.parse(raw) as { entries: { dummy: ChartEntry[] } };
    expect(parsed.entries.dummy.map((e) => e.version)).toEqual([
      '1.1.0',
      '1.0.0',
    ]);
  });

  it('append replaces same version entry rather than duplicating', () => {
    const base = tmpdir();
    const chartDir = writeChartYaml(base, 'demo', '2.0.0');
    const chart = HelmChart.from(chartDir);
    const idxPath = path.join(base, 'charts', 'index.yaml');

    const tgz1 = writeTgz(base, 'demo', '2.0.0', 'first');
    const i0 = HelmIndex.fromFile(idxPath);
    const i1 = i0.append(chart, tgz1, 'https://u.test/charts');
    i1.writeTo(idxPath);

    const tgz2 = writeTgz(base, 'demo', '2.0.0', 'second');
    const i2 = HelmIndex.fromFile(idxPath);
    const i3 = i2.append(chart, tgz2, 'https://u.test/charts');
    i3.writeTo(idxPath);

    const raw = fs.readFileSync(idxPath, 'utf8');
    const parsed = yaml.parse(raw) as { entries: { demo: ChartEntry[] } };
    expect(parsed.entries.demo.length).toEqual(1);
  });

  it('sorting keeps higher semver first', () => {
    const base = tmpdir();
    const chartDir = writeChartYaml(base, 'svc', '1.0.0');
    const chart100 = HelmChart.from(chartDir);
    const idxPath = path.join(base, 'charts', 'index.yaml');

    const i0 = HelmIndex.empty();
    const tgz100 = writeTgz(base, 'svc', '1.0.0', 'x');
    const i1 = i0.append(chart100, tgz100, 'https://ex.test/charts');
    i1.writeTo(idxPath);

    const chart200 = chart100.withVersion('2.0.0');
    const tgz200 = writeTgz(base, 'svc', '2.0.0', 'y');
    const i2 = HelmIndex.fromFile(idxPath);
    const i3 = i2.append(chart200, tgz200, 'https://ex.test/charts');
    i3.writeTo(idxPath);

    const raw = fs.readFileSync(idxPath, 'utf8');
    const parsed = yaml.parse(raw) as { entries: { svc: ChartEntry[] } };
    expect(parsed.entries.svc.map((e) => e.version)).toEqual([
      '2.0.0',
      '1.0.0',
    ]);
  });
});
