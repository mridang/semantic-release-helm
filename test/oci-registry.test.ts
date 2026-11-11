import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { ChartPackage } from '../src/chart-package.js';
import { DockerImage } from '../src/docker.js';
import { OciRegistry } from '../src/oci-registry.js';
import { fakeRunner, recordingLogger } from './utils/runner.js';

const PASSWORD = 'placeholder$x "q" \'z\' `id`';
const PKG = ChartPackage.at('/repo/dist/charts/app-1.0.0.tgz');
/** An unset option, declared without a literal `undefined` so it can be passed explicitly. */
let absent: undefined;

const make = (
  change: Partial<ConstructorParameters<typeof OciRegistry>[0]> = {},
  answer?: Parameters<typeof fakeRunner>[0],
) => {
  const { run, calls } = fakeRunner(answer);
  const { logger, lines } = recordingLogger();
  const helm = new DockerImage({
    image: 'alpine/helm:3',
    logger,
    cwd: '/repo',
    run,
  });
  const registry = new OciRegistry({
    repo: 'oci://reg.example.test:5000/charts',
    hostPort: 'reg.example.test:5000',
    insecure: false,
    username: 'user',
    password: PASSWORD,
    helm,
    cwd: '/repo',
    ...change,
  });
  return { registry, calls, lines };
};

/** The script the container ran. */
const scriptOf = (args: readonly string[] | undefined): string => {
  const list = args ?? [];
  return list[list.indexOf('alpine/helm:3') + 2] ?? '';
};

describe('OciRegistry.publish', () => {
  it('logs in with the password read from the environment, then pushes', async () => {
    const { registry, calls } = make();
    await registry.publish(PKG);
    expect(scriptOf(calls[0]?.args)).toBe(
      'helm registry login --username=user --password="$OCI_PASSWORD" reg.example.test:5000' +
        ' && helm push dist/charts/app-1.0.0.tgz oci://reg.example.test:5000/charts',
    );
    expect(calls[0]?.args).toContain('--entrypoint=/bin/sh');
  });

  it('hands the password to the runner in env and to nothing that is logged or run', async () => {
    const { registry, calls, lines } = make();
    await registry.publish(PKG);
    expect(calls[0]?.options?.env).toEqual({ OCI_PASSWORD: PASSWORD });
    expect(calls[0]?.args).toContain('--env=OCI_PASSWORD');
    expect([...(calls[0]?.args ?? []), ...lines].join('\n')).not.toContain(
      'placeholder',
    );
  });

  it('returns the published chart with the digest Helm printed', async () => {
    const { registry } = make({}, () => 'Pushed: x\nDigest: sha256:abc123\n');
    expect(await registry.publish(PKG)).toEqual({
      reference: 'oci://reg.example.test:5000/charts',
      package: PKG,
      digest: 'sha256:abc123',
    });
  });

  it('has no digest when Helm printed none', async () => {
    const { registry } = make();
    const published = await registry.publish(PKG);
    expect(published.digest).toBeUndefined();
  });

  it('has an empty environment without a password', async () => {
    const { registry, calls } = make({ password: absent });
    await registry.publish(PKG);
    expect(calls[0]?.options?.env).toEqual({});
    expect(scriptOf(calls[0]?.args)).not.toContain('login');
  });

  it('writes the insecure registry config and adds the insecure flags', async () => {
    const { registry, calls } = make({ insecure: true });
    await registry.publish(PKG);
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
      { username: absent },
      { password: absent },
      { hostPort: absent },
    ]) {
      const { registry, calls } = make(change);
      await registry.publish(PKG);
      expect(scriptOf(calls[0]?.args)).not.toContain('login');
    }
  });

  it('single-quotes values that contain shell metacharacters', async () => {
    const { registry, calls } = make({
      username: "a'; id; '",
      repo: 'oci://h/c; id',
    });
    await registry.publish(ChartPackage.at('/repo/dist/charts/my chart.tgz'));
    const script = scriptOf(calls[0]?.args);
    expect(script).toContain(String.raw`--username='a'\''; id; '\'''`);
    expect(script).toContain(
      `helm push 'dist/charts/my chart.tgz' 'oci://h/c; id'`,
    );
  });
});
