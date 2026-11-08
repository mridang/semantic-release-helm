import { expect, test } from '@jest/globals';
import { DockerImage } from '../../src/docker/image.js';
import { DockerCliClient } from '../../src/docker/cli-client.js';

function makeLogger() {
  return { log: () => {}, error: () => {} };
}

test('DockerImage.pullOrThrow delegates to client pull', async () => {
  const calls: string[] = [];
  const runner = (cmd: string) => {
    calls.push(cmd);
    return { stdout: '' };
  };
  const img = new DockerImage(
    'alpine:3',
    '/repo',
    makeLogger(),
    new DockerCliClient(runner),
  );
  await img.pullOrThrow();
  expect(calls[0]).toBe('docker pull alpine:3');
});

test('DockerImage.run mounts repo at /apps by default', async () => {
  const calls: string[] = [];
  const runner = (cmd: string) => {
    calls.push(cmd);
    return { stdout: '' };
  };
  const img = new DockerImage(
    'alpine:3',
    '/repo',
    makeLogger(),
    new DockerCliClient(runner),
  );
  await img.run(['echo', 'hi']);
  expect(calls[0]).toContain('--volume=/repo:/apps');
  expect(calls[0]).toContain("'hi'");
});

test('DockerImage.shell sets entrypoint and -lc', async () => {
  const calls: string[] = [];
  const runner = (cmd: string) => {
    calls.push(cmd);
    return { stdout: '' };
  };
  const img = new DockerImage(
    'alpine:3',
    '/repo',
    makeLogger(),
    new DockerCliClient(runner),
  );
  await img.shell('echo 1 && echo 2');
  expect(calls[0]).toContain('--entrypoint=/bin/sh');
  expect(calls[0]).toContain('-lc');
  expect(calls[0]).toContain("'echo 1 && echo 2'");
});

test('DockerImage.shell hands env values to the client by name', async () => {
  const seen: Array<Readonly<Record<string, string>> | undefined> = [];
  const img = new DockerImage(
    'alpine:3',
    '/repo',
    makeLogger(),
    new DockerCliClient((_cmd, _cwd, env) => {
      seen.push(env);
      return { stdout: '' };
    }),
  );
  await img.shell('true', { PW: 'x' });
  expect(seen).toEqual([{ PW: 'x' }]);
});

test('DockerImage.run does not set an entrypoint', async () => {
  const calls: string[] = [];
  const img = new DockerImage(
    'alpine:3',
    '/repo',
    makeLogger(),
    new DockerCliClient((cmd) => {
      calls.push(cmd);
      return { stdout: '' };
    }),
  );
  await img.run(['echo']);
  expect(calls[0]).not.toContain('--entrypoint');
});

test('DockerImage uses the default add-host and workdir', async () => {
  const calls: string[] = [];
  const img = new DockerImage(
    'alpine:3',
    '/repo',
    makeLogger(),
    new DockerCliClient((cmd) => {
      calls.push(cmd);
      return { stdout: '' };
    }),
  );
  await img.run(['echo']);
  expect(calls[0]).toContain('--add-host=host.docker.internal:host-gateway');
  expect(calls[0]).toContain('--workdir=/apps');
});

test('DockerImage honours workdir, mounts and add-host overrides', async () => {
  const calls: string[] = [];
  const img = new DockerImage(
    'alpine:3',
    '/repo',
    makeLogger(),
    new DockerCliClient((cmd) => {
      calls.push(cmd);
      return { stdout: '' };
    }),
    {
      workdir: '/work',
      mounts: [{ host: '/data', container: '/mnt', readonly: true }],
      addHosts: ['db:10.0.0.1'],
    },
  );
  await img.run(['echo']);
  expect(calls[0]).toContain('--workdir=/work');
  expect(calls[0]).toContain('--volume=/data:/mnt:ro');
  expect(calls[0]).toContain('--add-host=db:10.0.0.1');
  expect(calls[0]).not.toContain('/repo');
  expect(calls[0]).not.toContain('host.docker.internal');
});
