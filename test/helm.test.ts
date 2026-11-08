import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { DockerClient } from '../src/docker.js';
import { HelmClient, templateSetArgs } from '../src/helm.js';
import { fakeRunner, recordingLogger } from './utils/runner.js';
import { withTempDir } from './utils/tmpdir.js';

const PUSH = {
  hostPort: 'reg.example.test:5000',
  repo: 'oci://reg.example.test:5000/charts',
  insecure: false,
  username: 'user',
  password: 'placeholder$x "q" \'z\' `id`',
  files: ['dist/charts/app-1.0.0.tgz'],
} as const;

const make = (cwd = '/repo', answer?: Parameters<typeof fakeRunner>[0]) => {
  const { run, calls } = fakeRunner(answer);
  const { logger, lines } = recordingLogger();
  const docker = new DockerClient({ logger, cwd, run });
  const helm = new HelmClient({
    docker,
    helmImage: 'alpine/helm:3',
    docsImage: 'jnorwood/helm-docs:v1',
    logger,
    cwd,
  });
  return { helm, calls, lines };
};

/** The arguments the container received, after the image. */
const containerArgs = (args: readonly string[] | undefined, image: string) =>
  (args ?? []).slice((args ?? []).indexOf(image) + 1);

const scriptOf = (args: readonly string[] | undefined): string =>
  containerArgs(args, 'alpine/helm:3')[1] ?? '';

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

describe('HelmClient lint, template and package', () => {
  it('runs each in the helm image', async () => {
    const { helm, calls } = make();
    await helm.lint('charts/app');
    await helm.template('charts/app', { a: { b: 'c' }, n: 1 });
    await helm.package('charts/app', 'dist/charts');
    expect(calls.map((c) => containerArgs(c.args, 'alpine/helm:3'))).toEqual([
      ['lint', 'charts/app'],
      ['template', 'sr-check', 'charts/app', '--set', 'a.b=c', '--set', 'n=1'],
      ['package', 'charts/app', '--destination=dist/charts'],
    ]);
  });

  it('adds no --set without template values', async () => {
    const { helm, calls } = make();
    await helm.template('charts/app', undefined);
    expect(containerArgs(calls[0]?.args, 'alpine/helm:3')).toEqual([
      'template',
      'sr-check',
      'charts/app',
    ]);
  });
});

describe('HelmClient.docs', () => {
  it(
    'normalizes the README and runs helm-docs',
    withTempDir(async (dir) => {
      fs.mkdirSync(path.join(dir, 'app'));
      fs.writeFileSync(
        path.join(dir, 'app', 'README.md'),
        '<!-- render.chart.valuesTable -->\nold\n<!-- end.chart.valuesTable -->\n',
      );
      const { helm, calls, lines } = make(dir);
      expect(await helm.docs('app', ['--template-files=README.md'])).toBe(true);
      expect(containerArgs(calls[0]?.args, 'jnorwood/helm-docs:v1')).toEqual([
        'helm-docs',
        '--chart-search-root=app',
        '--template-files=README.md',
      ]);
      expect(
        fs.readFileSync(path.join(dir, 'app', 'README.md'), 'utf8'),
      ).toContain('{{ template "chart.valuesTable" . }}');
      expect(lines).toContain(
        'helm-docs: normalized README valuesTable block(s)',
      );
    }),
  );

  it(
    'says so when there is no README or no marker',
    withTempDir(async (dir) => {
      fs.mkdirSync(path.join(dir, 'app'));
      const a = make(dir);
      await a.helm.docs('app', []);
      expect(a.lines).toContain(
        'helm-docs: README.md not found; skipping normalization',
      );
      fs.writeFileSync(path.join(dir, 'app', 'README.md'), '# nothing\n');
      const b = make(dir);
      await b.helm.docs('app', []);
      expect(b.lines).toContain(
        'helm-docs: README normalization not needed (no markers found)',
      );
    }),
  );

  it('reports false instead of throwing when helm-docs fails', async () => {
    const { helm } = make('/repo', () => {
      throw new Error('no such image');
    });
    expect(await helm.docs('app', [])).toBe(false);
  });
});

describe('HelmClient.pushToOci', () => {
  it('logs in with the password read from the environment, then pushes', async () => {
    const { helm, calls } = make();
    await helm.pushToOci(PUSH);
    expect(scriptOf(calls[0]?.args)).toBe(
      'helm registry login --username=user --password="$OCI_PASSWORD" reg.example.test:5000' +
        ' && helm push dist/charts/app-1.0.0.tgz oci://reg.example.test:5000/charts',
    );
    expect(calls[0]?.args).toContain('--entrypoint=/bin/sh');
  });

  it('hands the password to the runner in env and to nothing that is logged or run', async () => {
    const { helm, calls, lines } = make();
    await helm.pushToOci(PUSH);
    expect(calls[0]?.options?.env).toEqual({ OCI_PASSWORD: PUSH.password });
    expect(calls[0]?.args).toContain('--env=OCI_PASSWORD');
    expect([...(calls[0]?.args ?? []), ...lines].join('\n')).not.toContain(
      'placeholder',
    );
  });

  it('has an empty environment without a password', async () => {
    const { helm, calls } = make();
    await helm.pushToOci({ ...PUSH, password: undefined });
    expect(calls[0]?.options?.env).toEqual({});
    expect(scriptOf(calls[0]?.args)).not.toContain('login');
  });

  it('writes the insecure registry config and adds the insecure flags', async () => {
    const { helm, calls } = make();
    await helm.pushToOci({ ...PUSH, insecure: true });
    expect(scriptOf(calls[0]?.args)).toBe(
      [
        'mkdir --parents /root/.config/helm/registry',
        `printf %s '{"auths":{"reg.example.test:5000":{"insecure":true}}}' > /root/.config/helm/registry/config.json`,
        'helm registry login --insecure --username=user --password="$OCI_PASSWORD" reg.example.test:5000',
        'helm push dist/charts/app-1.0.0.tgz oci://reg.example.test:5000/charts --plain-http',
      ].join(' && '),
    );
  });

  it('skips the login without a username, a password or a host', async () => {
    for (const change of [
      { username: undefined },
      { password: undefined },
      { hostPort: undefined },
    ]) {
      const { helm, calls } = make();
      await helm.pushToOci({ ...PUSH, ...change });
      expect(scriptOf(calls[0]?.args)).not.toContain('login');
    }
  });

  it('pushes every packaged chart in order', async () => {
    const { helm, calls } = make();
    await helm.pushToOci({
      ...PUSH,
      username: undefined,
      files: ['dist/charts/a-1.tgz', 'dist/charts/b-2.tgz'],
    });
    expect(scriptOf(calls[0]?.args)).toBe(
      'helm push dist/charts/a-1.tgz oci://reg.example.test:5000/charts && helm push dist/charts/b-2.tgz oci://reg.example.test:5000/charts',
    );
  });

  it('single-quotes values that contain shell metacharacters', async () => {
    const { helm, calls } = make();
    await helm.pushToOci({
      ...PUSH,
      username: "a'; id; '",
      files: ['dist/charts/my chart.tgz'],
      repo: 'oci://h/c; id',
    });
    const script = scriptOf(calls[0]?.args);
    expect(script).toContain(`--username='a'\\''; id; '\\'''`);
    expect(script).toContain(
      `helm push 'dist/charts/my chart.tgz' 'oci://h/c; id'`,
    );
  });
});
