import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  Chart,
  ChartYaml,
  setChartVersion,
  templateSetArgs,
} from '../src/chart.js';
import { ChartPackage } from '../src/chart-package.js';
import { DockerImage } from '../src/docker.js';
import { fakeRunner, recordingLogger } from './utils/runner.js';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { withTempDir } from './utils/tmpdir.js';

/** The pieces a chart needs, with a recording runner. */
function setup(cwd: string, answer?: Parameters<typeof fakeRunner>[0]) {
  const { run, calls } = fakeRunner(answer);
  const { logger, lines } = recordingLogger();
  const helm = new DockerImage({ image: 'helm:3', logger, cwd, run });
  const docs = new DockerImage({ image: 'docs:1', logger, cwd, run });
  return { options: { cwd, logger, run, helm, docs }, calls, lines };
}

/** A chart in a directory, with images that only record what they run. */
function chartAt(dir: string): Chart {
  return Chart.open({ ...setup(dir).options, directory: '' });
}

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

describe('Chart', () => {
  /**
   * Loads name and version from Chart.yaml to ensure the parser extracts
   * required core fields correctly and exposes them via accessors.
   */
  it(
    'loads name and version',
    withTempDir((base: string) => {
      const chartDir = writeChart(base, 'demo', '1.2.3');
      const chart = chartAt(chartDir);
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
      const c1 = chartAt(writeChart(base, 'demo', '1.0.0'));
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
      chartAt(dir).withVersion('0.2.0').save();
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
    'writes valid YAML when saved',
    withTempDir((base: string) => {
      const dir = writeChart(base, 'demo', '9.9.9');
      chartAt(dir).save();
      const text = fs.readFileSync(path.join(dir, 'Chart.yaml'), 'utf8');
      expect(yaml.parse(text) as ChartYaml).toEqual({
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
      const chart = chartAt(writeChart(base, 'demo', '1.0.0', { a: 1 }));
      const r1 = chart.metadata();
      (r1 as Record<string, unknown>).a = 2;
      expect(chart.metadata()).toEqual({
        apiVersion: 'v2',
        name: 'demo',
        version: '1.0.0',
        description: 'X',
        a: 1,
      });
    }),
  );
});

describe('Chart.open with unusual Chart.yaml content', () => {
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
      const chart = chartAt(dir);
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
      const chart = chartAt(dir);
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

  it('refuses a version that an alias points to', () => {
    expect(() =>
      setChartVersion('name: d\nversion: &v 1.0.0\nappVersion: *v\n', '2.0.0'),
    ).toThrow(expect.objectContaining({ code: 'EINVALIDCHARTYAML' }));
  });

  it('rewrites an anchored version that nothing aliases and keeps the anchor', () => {
    expect(setChartVersion('name: d\nversion: &v 1.0.0\n', '2.0.0')).toBe(
      'name: d\nversion: &v 2.0.0\n',
    );
  });

  it('allows an anchor on a different key', () => {
    expect(
      setChartVersion('base: &b x\nref: *b\nversion: 1.0.0\n', '2.0.0'),
    ).toBe('base: &b x\nref: *b\nversion: 2.0.0\n');
  });

  it.each([
    [
      'unindented lists',
      'name: d\nversion: 1.0.0\ndependencies:\n- name: a\n  version: 1\n',
    ],
    ['CRLF line endings', 'name: d\r\nversion: 1.0.0\r\nx: 1\r\n'],
    ['runs of blank lines', 'name: d\n\n\n\nversion: 1.0.0\n\n# end\n'],
    ['numbers like 0100', 'appVersion: 0100\nmode: 0777\nversion: 1.0.0\n'],
    ['big integers', 'big: 12345678901234567890\nversion: 1.0.0\n'],
    [
      'long scalars',
      `description: ${'word '.repeat(40).trim()}\nversion: 1.0.0\n`,
    ],
    ['tabs inside comments', 'name: d # a\tb\nversion: 1.0.0 # keep\n'],
  ])('changes only the version and keeps %s byte for byte', (_label, raw) => {
    expect(setChartVersion(raw, '2.0.0')).toBe(raw.replace('1.0.0', '2.0.0'));
  });

  it('keeps the quoting style of the existing version', () => {
    expect(setChartVersion('version: "1.0.0"\n', '2.0.0')).toBe(
      'version: "2.0.0"\n',
    );
    expect(setChartVersion("version: '1.0.0'\n", '2.0.0')).toBe(
      "version: '2.0.0'\n",
    );
  });

  it('quotes a version that would otherwise read as a number', () => {
    expect(yaml.parse(setChartVersion('version: 1.0.0\n', '2'))).toEqual({
      version: '2',
    });
  });

  it.each([
    ['blank', 'name: d\nversion:\nx: 1\n', 'name: d\nversion: 2.0.0\nx: 1\n'],
    [
      'blank at the end of the file',
      'name: d\nversion:',
      'name: d\nversion: 2.0.0',
    ],
    ['blank before a comment', 'version: # todo\n', 'version: 2.0.0 # todo\n'],
    ['~', 'version: ~\n', 'version: 2.0.0\n'],
    ['null', 'version: null\n', 'version: 2.0.0\n'],
    ['Null', 'version: Null\n', 'version: 2.0.0\n'],
    ['NULL', 'version: NULL # x\n', 'version: 2.0.0 # x\n'],
  ])('replaces a %s version', (_label, raw, expected) => {
    expect(setChartVersion(raw, '2.0.0')).toBe(expected);
  });

  it('replaces a blank version in a flow mapping', () => {
    expect(
      yaml.parse(setChartVersion('{name: d, version: }\n', '2.0.0')),
    ).toEqual({
      name: 'd',
      version: '2.0.0',
    });
  });

  it('refuses a block scalar version', () => {
    expect(() => setChartVersion('version: |\n  1.0.0\n', '2.0.0')).toThrow(
      expect.objectContaining({ code: 'EINVALIDCHARTYAML' }),
    );
  });

  it('refuses a version that is not a scalar', () => {
    expect(() => setChartVersion('version: [1]\n', '2.0.0')).toThrow(
      expect.objectContaining({ code: 'EINVALIDCHARTYAML' }),
    );
  });

  it('appends a version when the mapping has none', () => {
    expect(setChartVersion('name: demo\n', '1.0.0')).toBe(
      'name: demo\nversion: 1.0.0\n',
    );
    expect(setChartVersion('name: demo', '1.0.0')).toBe(
      'name: demo\nversion: 1.0.0\n',
    );
    expect(setChartVersion('name: demo\r\n', '1.0.0')).toBe(
      'name: demo\r\nversion: 1.0.0\r\n',
    );
  });

  it('adds a version to a flow mapping', () => {
    expect(yaml.parse(setChartVersion('{name: demo}\n', '1.0.0'))).toEqual({
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

  it('turns a YAML syntax error into a coded error that names the file', () => {
    expect(() => setChartVersion('a: [\n', '1.0.0', 'app/Chart.yaml')).toThrow(
      expect.objectContaining({
        code: 'EINVALIDCHARTYAML',
        details: expect.stringContaining('app/Chart.yaml'),
      }),
    );
  });

  it('refuses multiple documents with a coded error', () => {
    expect(() => setChartVersion('a: 1\n---\nb: 2\n', '1.0.0')).toThrow(
      expect.objectContaining({ code: 'EINVALIDCHARTYAML' }),
    );
  });
});

describe('Chart.open with invalid YAML', () => {
  it(
    'raises a coded error that names the file',
    withTempDir((base: string) => {
      const dir = path.join(base, 'bad');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'Chart.yaml'), 'a: 1\n---\nb: 2\n');
      expect(() => chartAt(dir)).toThrow(
        expect.objectContaining({
          code: 'EINVALIDCHARTYAML',
          details: expect.stringContaining('Chart.yaml'),
        }),
      );
    }),
  );
});

describe('Chart working with Helm', () => {
  const chartIn = (base: string, answer?: Parameters<typeof fakeRunner>[0]) => {
    writeChart(base, 'app', '1.2.3');
    const s = setup(base, answer);
    const chart = Chart.open({ ...s.options, directory: 'app' });
    return { chart, ...s };
  };

  /** The arguments the container received, after the image. */
  const afterImage = (args: readonly string[] | undefined, image: string) =>
    (args ?? []).slice((args ?? []).indexOf(image) + 1);

  it(
    'lints, renders and packages in the helm image',
    withTempDir(async (base) => {
      const { chart, calls } = chartIn(base);
      await chart.lint();
      await expect(chart.render({ a: { b: 'c' }, n: 1 })).resolves.toBe('');
      const pkg = await chart.package('dist/charts');
      expect(calls.map((c) => afterImage(c.args, 'helm:3'))).toEqual([
        ['lint', 'app'],
        ['template', 'sr-check', 'app', '--set', 'a.b=c', '--set', 'n=1'],
        ['package', 'app', '--destination=dist/charts'],
      ]);
      expect(pkg.relativeTo(base)).toBe(
        path.join('dist', 'charts', 'app-1.2.3.tgz'),
      );
      expect(pkg.version).toBe('1.2.3');
    }),
  );

  it(
    'returns the rendered manifest',
    withTempDir(async (base) => {
      const { chart } = chartIn(base, () => 'kind: ConfigMap\n');
      expect(await chart.render(undefined)).toBe('kind: ConfigMap');
    }),
  );

  it(
    'adds no --set without template values',
    withTempDir(async (base) => {
      const { chart, calls } = chartIn(base);
      await chart.render(undefined);
      expect(afterImage(calls[0]?.args, 'helm:3')).toEqual([
        'template',
        'sr-check',
        'app',
      ]);
    }),
  );

  it(
    'writes a new version only when saved',
    withTempDir(async (base) => {
      const { chart } = chartIn(base);
      const next = chart.withVersion('2.0.0');
      expect(next.version()).toBe('2.0.0');
      expect(chart.version()).toBe('1.2.3');
      expect(
        fs.readFileSync(path.join(base, 'app', 'Chart.yaml'), 'utf8'),
      ).toContain('1.2.3');
      expect(next.save()).toBe(next);
      expect(
        fs.readFileSync(path.join(base, 'app', 'Chart.yaml'), 'utf8'),
      ).toContain('2.0.0');
    }),
  );

  it(
    'normalizes the README and runs helm-docs',
    withTempDir(async (base) => {
      const { chart, calls, lines } = chartIn(base);
      fs.writeFileSync(
        path.join(base, 'app', 'README.md'),
        '<!-- render.chart.valuesTable -->\nold\n<!-- end.chart.valuesTable -->\n',
      );
      expect(await chart.document(['--template-files=README.md'])).toBe(chart);
      expect(afterImage(calls[0]?.args, 'docs:1')).toEqual([
        'helm-docs',
        '--chart-search-root=app',
        '--template-files=README.md',
      ]);
      expect(
        fs.readFileSync(path.join(base, 'app', 'README.md'), 'utf8'),
      ).toContain('{{ template "chart.valuesTable" . }}');
      expect(lines).toContain(
        'helm-docs: normalized README valuesTable block(s)',
      );
      expect(lines).toContain('prepare: helm-docs succeeded');
    }),
  );

  it(
    'says so when there is no README or no marker',
    withTempDir(async (base) => {
      const a = chartIn(base);
      await a.chart.document([]);
      expect(a.lines).toContain(
        'helm-docs: README.md not found; skipping normalization',
      );
      fs.writeFileSync(path.join(base, 'app', 'README.md'), '# nothing\n');
      const b = chartIn(base);
      await b.chart.document([]);
      expect(b.lines).toContain(
        'helm-docs: README normalization not needed (no markers found)',
      );
    }),
  );

  it(
    'logs instead of throwing when helm-docs fails',
    withTempDir(async (base) => {
      const { chart, lines } = chartIn(base, () => {
        throw new Error('no such image');
      });
      expect(await chart.document([])).toBe(chart);
      expect(lines).toContain(
        'prepare: helm-docs failed or missing; skipping docs generation',
      );
    }),
  );

  it(
    'selects only its own package from a listing',
    withTempDir((base) => {
      const { chart } = chartIn(base);
      const found = ['app-1.2.3.tgz', 'app-1.0.0.tgz', 'other-1.2.3.tgz'].map(
        (n) => ChartPackage.at(path.join(base, n)),
      );
      expect(chart.select(found).map((p) => p.fileName)).toEqual([
        'app-1.2.3.tgz',
      ]);
    }),
  );

  it(
    'tells whether a chart exists',
    withTempDir((base) => {
      writeChart(base, 'app', '1.0.0');
      expect(Chart.exists({ cwd: base, directory: 'app' })).toBe(true);
      expect(Chart.exists({ cwd: base, directory: 'missing' })).toBe(false);
    }),
  );
});
describe('templateSetArgs', () => {
  it('emits one --set per flattened leaf', () => {
    expect(
      templateSetArgs({
        image: { tag: 'v1', pull: { policy: 'Always' } },
        n: 3,
      }),
    ).toEqual([
      '--set',
      'image.tag=v1',
      '--set',
      'image.pull.policy=Always',
      '--set',
      'n=3',
    ]);
  });

  it('stringifies arrays and null without descending', () => {
    expect(templateSetArgs({ list: ['a', 'b'], nothing: null })).toEqual([
      '--set',
      'list=a,b',
      '--set',
      'nothing=null',
    ]);
  });

  it('is empty without values', () => {
    expect(templateSetArgs(undefined)).toEqual([]);
    expect(templateSetArgs({})).toEqual([]);
  });
});
