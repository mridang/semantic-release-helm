import { describe, expect, it } from '@jest/globals';
import { DockerCliClient } from '../src/docker/cli-client.js';
import { DockerImage } from '../src/docker/image.js';
import { buildOciPublish } from '../src/oci-publish.js';

const BASE = {
  hostPort: 'reg.example.test:5000',
  repo: 'oci://reg.example.test:5000/charts',
  insecure: false,
  username: 'user',
  password: 'placeholder$x "q" \'z\' `id`',
  files: ['dist/charts/app-1.0.0.tgz'],
} as const;

describe('buildOciPublish', () => {
  it('logs in with the password read from the environment, then pushes', () => {
    expect(buildOciPublish(BASE).script).toBe(
      'helm registry login --username=user --password="$OCI_PASSWORD" reg.example.test:5000' +
        ' && helm push dist/charts/app-1.0.0.tgz oci://reg.example.test:5000/charts',
    );
  });

  it('passes the password only through the environment', () => {
    const { script, env } = buildOciPublish(BASE);
    expect(env).toEqual({ OCI_PASSWORD: BASE.password });
    expect(script).not.toContain('placeholder');
    expect(script).not.toContain(BASE.password);
  });

  it('has an empty environment without a password', () => {
    expect(buildOciPublish({ ...BASE, password: undefined }).env).toEqual({});
  });

  it('writes the insecure registry config and adds the insecure flags', () => {
    const script = buildOciPublish({ ...BASE, insecure: true }).script;
    expect(script).toBe(
      [
        'mkdir --parents /root/.config/helm/registry',
        `printf %s '{"auths":{"reg.example.test:5000":{"insecure":true}}}' > /root/.config/helm/registry/config.json`,
        'helm registry login --insecure --username=user --password="$OCI_PASSWORD" reg.example.test:5000',
        'helm push dist/charts/app-1.0.0.tgz oci://reg.example.test:5000/charts --plain-http',
      ].join(' && '),
    );
  });

  it('skips the login without a username, a password or a host', () => {
    expect(
      buildOciPublish({ ...BASE, username: undefined }).script,
    ).not.toContain('login');
    expect(
      buildOciPublish({ ...BASE, password: undefined }).script,
    ).not.toContain('login');
    expect(
      buildOciPublish({ ...BASE, hostPort: undefined }).script,
    ).not.toContain('login');
  });

  it('pushes every packaged chart in order', () => {
    const script = buildOciPublish({
      ...BASE,
      username: undefined,
      files: ['dist/charts/a-1.tgz', 'dist/charts/b-2.tgz'],
    }).script;
    expect(script).toBe(
      'helm push dist/charts/a-1.tgz oci://reg.example.test:5000/charts && helm push dist/charts/b-2.tgz oci://reg.example.test:5000/charts',
    );
  });

  it('single-quotes values that contain shell metacharacters', () => {
    const script = buildOciPublish({
      ...BASE,
      username: "a'; id; '",
      files: ['dist/charts/my chart.tgz'],
      repo: 'oci://h/c; id',
    }).script;
    expect(script).toContain(`--username='a'\\''; id; '\\'''`);
    expect(script).toContain(
      `helm push 'dist/charts/my chart.tgz' 'oci://h/c; id'`,
    );
  });
});

describe('OCI publish secret wiring through the docker layer', () => {
  it('hands the password to the runner in env and to nothing that is logged or run', async () => {
    const password = 'placeholder$x "q" \'z\'';
    const runs: Array<{
      cmd: string;
      env: Readonly<Record<string, string>> | undefined;
    }> = [];
    const logs: string[] = [];
    const logger = {
      log: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    };
    const { script, env } = buildOciPublish({
      hostPort: 'reg.example.test:5000',
      repo: 'oci://reg.example.test:5000/charts',
      insecure: false,
      username: 'user',
      password,
      files: ['dist/charts/app-1.0.0.tgz'],
    });
    await new DockerImage(
      'alpine/helm:3',
      '/repo',
      logger,
      new DockerCliClient((cmd, _cwd, e) => {
        runs.push({ cmd, env: e });
        return { stdout: '' };
      }),
    ).shell(script, env);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.env).toEqual({ OCI_PASSWORD: password });
    expect(runs[0]?.cmd).toContain('--env=OCI_PASSWORD');
    expect(runs[0]?.cmd).not.toContain('placeholder');
    expect(logs.join('\n')).not.toContain('placeholder');
  });
});
