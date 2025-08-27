import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { HelmChart, ChartYaml } from '../src/helm-chart.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function tmpdir(): string {
  const d = path.join(__dirname, `.tmp-chart-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeChart(dir: string, name: string, version: string): string {
  const chartDir = path.join(dir, 'charts', name);
  fs.mkdirSync(chartDir, { recursive: true });
  const chartFile = path.join(chartDir, 'Chart.yaml');
  const doc = yaml.stringify({
    apiVersion: 'v2',
    name,
    version,
    description: 'X',
  } as ChartYaml);
  fs.writeFileSync(chartFile, doc, 'utf8');
  return chartDir;
}

describe('HelmChart', () => {
  it('loads name and version from Chart.yaml', () => {
    const base = tmpdir();
    const chartDir = writeChart(base, 'demo', '1.2.3');
    const chart = HelmChart.from(chartDir);
    expect({ name: chart.name(), version: chart.version() }).toEqual({
      name: 'demo',
      version: '1.2.3',
    });
  });

  it('withVersion returns a new immutable instance', () => {
    const base = tmpdir();
    const chartDir = writeChart(base, 'demo', '1.0.0');
    const c1 = HelmChart.from(chartDir);
    const c2 = c1.withVersion('1.1.0');
    expect({
      old: c1.version(),
      new: c2.version(),
    }).toEqual({
      old: '1.0.0',
      new: '1.1.0',
    });
  });

  it('saveTo writes YAML out', () => {
    const base = tmpdir();
    const chartDir = writeChart(base, 'demo', '0.1.0');
    const c1 = HelmChart.from(chartDir);
    const file = path.join(chartDir, 'Chart.yaml');
    const c2 = c1.withVersion('0.2.0');
    c2.saveTo(file);
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = yaml.parse(raw) as ChartYaml;
    expect(parsed).toEqual({
      apiVersion: 'v2',
      name: 'demo',
      version: '0.2.0',
      description: 'X',
    });
  });
});
