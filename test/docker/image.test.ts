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
