import { expect, test } from '@jest/globals';
import {
  buildDockerPull,
  buildDockerRun,
  DockerCliClient,
} from '../../src/docker/cli-client.js';
// noinspection ES6PreferShortImport
import { shQuote } from '../../src/utils/shell.js';

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

test('DockerCliClient logs and rethrows without credentials in the command or error', async () => {
  const logs: string[] = [];
  const url = 'oci://u:tok3nvalue@localhost:5000/charts';
  const client = new DockerCliClient(() => {
    throw new Error(`push to ${url} failed`);
  });
  const failure = await client
    .run('alpine:3', ['push', url], {
      cwd: '/repo',
      logger: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    })
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  expect(logs.join('\n')).not.toContain('tok3nvalue');
  expect(String((failure as Error).message)).not.toContain('tok3nvalue');
});

test('DockerCliClient.run with env keeps short values from mangling the message', async () => {
  const client = new DockerCliClient(() => {
    throw new Error('Command failed: unauthorized');
  });
  await expect(
    client.run('alpine:3', ['true'], {
      cwd: '/repo',
      env: { PW: 'a' },
      logger: { log: () => {}, error: () => {} },
    }),
  ).rejects.toThrow('Command failed: unauthorized');
});

test('DockerCliClient.run with env replaces an empty or non-Error failure with a fixed message', async () => {
  const run = (thrown: unknown) =>
    new DockerCliClient(() => {
      throw thrown;
    }).run('alpine:3', ['true'], {
      cwd: '/repo',
      env: { PW: 'secretvalue' },
      logger: { log: () => {}, error: () => {} },
    });
  await expect(run('')).rejects.toThrow('environment variable(s) PW');
  await expect(run(new Error(''))).rejects.toThrow(
    'environment variable(s) PW',
  );
});

test('DockerCliClient.run with env scrubs encoded forms and keeps code and status', async () => {
  const value = 'p@ss word';
  const failure = await new DockerCliClient(() => {
    throw Object.assign(
      new Error(
        `bad ${encodeURIComponent(value)} and ${Buffer.from(value).toString('base64')} and ${value}`,
      ),
      { code: 'E_X', status: 9 },
    );
  })
    .run('alpine:3', ['true'], {
      cwd: '/repo',
      env: { PW: value },
      logger: { log: () => {}, error: () => {} },
    })
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  expect(failure).toMatchObject({
    message: 'bad *** and *** and ***',
    code: 'E_X',
    status: 9,
  });
});

test('DockerCliClient.run with env names the code of a spawn failure', async () => {
  await expect(
    new DockerCliClient(() => {
      throw Object.assign(new Error('Received sec\u0000ret'), {
        code: 'ERR_INVALID_ARG_VALUE',
      });
    }).run('alpine:3', ['true'], {
      cwd: '/repo',
      env: { PW: 'sec\u0000ret' },
      logger: { log: () => {}, error: () => {} },
    }),
  ).rejects.toThrow('(ERR_INVALID_ARG_VALUE)');
});
