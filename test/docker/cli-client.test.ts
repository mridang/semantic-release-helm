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

test('buildDockerRun quotes mounts, workdir, entrypoint, image and flags', () => {
  const cmd = buildDockerRun('img; touch /x', ['--opt=a b', '$(id)'], {
    workdir: '/w d',
    mounts: [{ host: '/my repo', container: '/apps' }],
    addHosts: ['h:g;x'],
    entrypoint: '/bin/sh -c',
  });
  expect(cmd).toBe(
    "docker run --rm '--add-host=h:g;x' '--volume=/my repo:/apps' '--workdir=/w d' '--entrypoint=/bin/sh -c' 'img; touch /x' '--opt=a b' '$(id)'",
  );
});

test('buildDockerPull quotes an image reference that needs it', () => {
  expect(buildDockerPull('img; id')).toBe("docker pull 'img; id'");
});

test('DockerCliClient.run passes env values to the runner but not into the command', async () => {
  const seen: Array<{ cmd: string; env?: Readonly<Record<string, string>> }> =
    [];
  const logs: string[] = [];
  const client = new DockerCliClient((cmd, _cwd, env) => {
    seen.push({ cmd, env });
    return { stdout: '' };
  });
  await client.run('alpine:3', ['echo'], {
    cwd: '/repo',
    env: { SECRET_TOKEN: 'placeholder$x' },
    logger: { log: (m) => logs.push(m), error: () => {} },
  });
  expect(seen[0]?.env).toEqual({ SECRET_TOKEN: 'placeholder$x' });
  expect(seen[0]?.cmd).toContain('--env=SECRET_TOKEN');
  expect([seen[0]?.cmd, ...logs].join('\n')).not.toContain('placeholder');
});

test('DockerCliClient.run with env never logs or throws the value of a NUL-byte password', async () => {
  const secret = 'sec\u0000ret';
  const logs: string[] = [];
  const client = new DockerCliClient();
  const failure = await client
    .run('alpine:3', ['true'], {
      cwd: process.cwd(),
      env: { OCI_PASSWORD: secret },
      logger: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    })
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  expect(failure).toBeInstanceOf(Error);
  const everything = [...logs, String((failure as Error).message)].join('\n');
  expect(everything).not.toContain('sec');
  expect(everything).not.toContain('ret');
  expect(everything).toContain('OCI_PASSWORD');
});

test('DockerCliClient.run with env removes the value from an ordinary failure message', async () => {
  const logs: string[] = [];
  const client = new DockerCliClient(() => {
    throw new Error('login failed for placeholder$x at registry');
  });
  await expect(
    client.run('alpine:3', ['true'], {
      cwd: '/repo',
      env: { OCI_PASSWORD: 'placeholder$x' },
      logger: { log: () => {}, error: (m) => logs.push(m) },
    }),
  ).rejects.toThrow('login failed for *** at registry');
  expect(logs).toEqual(['login failed for *** at registry']);
});
