import { expect, test } from '@jest/globals';
import {
  buildDockerPull,
  buildDockerRun,
  DockerCliClient,
  shQuote,
} from '../../src/docker/cli-client.js';

function makeLogger() {
  return { log: () => {}, error: () => {} };
}

test('shQuote handles spaces and single quotes', () => {
  expect(shQuote('a b')).toBe("'a b'");
  expect(shQuote("a'b")).toBe("'a'\\''b'");
});

test('buildDockerPull returns deterministic pull command', () => {
  expect(buildDockerPull('img:tag')).toBe('docker pull img:tag');
});

test('buildDockerRun builds default run command', () => {
  const cmd = buildDockerRun('alpine:3', ['echo', 'a b', '--flag'], {
    workdir: '/apps',
    mounts: [{ host: '/repo', container: '/apps' }],
    addHosts: ['host.docker.internal:host-gateway'],
  });
  expect(cmd).toContain('docker run --rm');
  expect(cmd).toContain('--add-host=host.docker.internal:host-gateway');
  expect(cmd).toContain('--volume=/repo:/apps');
  expect(cmd).toContain('--workdir=/apps');
  expect(cmd).toContain('alpine:3');
  expect(cmd).toContain("'a b'");
  expect(cmd).toContain('--flag');
});

test('DockerCliClient.run uses injected runner and returns stdout', async () => {
  const seen: string[] = [];
  const runner = (cmd: string) => {
    seen.push(cmd);
    return { stdout: 'ok' };
  };
  const client = new DockerCliClient(runner);
  const logger = makeLogger();
  const res = await client.run('alpine:3', ['echo', 'hi'], {
    cwd: '/repo',
    logger,
  });
  expect(res.stdout).toBe('ok');
  expect(seen[0]).toContain('--volume=/repo:/apps');
  expect(seen[0]).toContain("'hi'");
});

test('DockerCliClient.pull maps runner error to SemanticReleaseError', async () => {
  const runner = () => {
    throw new Error('boom');
  };
  const client = new DockerCliClient(runner);
  const logger = makeLogger();
  await expect(client.pull('img:tag', logger)).rejects.toMatchObject({
    code: 'EIMAGEPULLFAILED',
  });
});

test('DockerCliClient.run logs the runner error message and rethrows', async () => {
  const errors: string[] = [];
  const client = new DockerCliClient(() => {
    throw new Error('exploded');
  });
  await expect(
    client.run('alpine:3', ['echo'], {
      cwd: '/repo',
      logger: { log: () => {}, error: (m) => errors.push(m) },
    }),
  ).rejects.toThrow('exploded');
  expect(errors).toEqual(['exploded']);
});

test('buildDockerRun adds read-only mounts and the entrypoint', () => {
  const cmd = buildDockerRun('alpine:3', ['-lc', 'echo 1'], {
    workdir: '/w',
    mounts: [{ host: '/a', container: '/b', readonly: true }],
    addHosts: [],
    entrypoint: '/bin/sh',
  });
  expect(cmd).toBe(
    "docker run --rm --volume=/a:/b:ro --workdir=/w --entrypoint=/bin/sh alpine:3 -lc 'echo 1'",
  );
});
