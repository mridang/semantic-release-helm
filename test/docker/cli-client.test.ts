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
