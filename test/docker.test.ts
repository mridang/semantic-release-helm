import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import {
  assertDockerAvailable,
  DockerImage,
  dockerRunArgs,
} from '../src/docker.js';
import { fakeRunner, recordingLogger } from './utils/runner.js';

const make = (
  answer?: Parameters<typeof fakeRunner>[0],
  extra: Partial<ConstructorParameters<typeof DockerImage>[0]> = {},
) => {
  const { run, calls } = fakeRunner(answer);
  const { logger, lines } = recordingLogger();
  const image = new DockerImage({
    image: 'alpine:3',
    logger,
    cwd: '/repo',
    run,
    ...extra,
  });
  return { image, context: { logger, cwd: '/repo', run }, calls, lines };
};

describe('dockerRunArgs', () => {
  it('builds the default run arguments', () => {
    const args = dockerRunArgs('alpine:3', ['echo', 'a b', '--flag'], {
      workdir: '/apps',
      mounts: [{ host: '/repo', container: '/apps' }],
      addHosts: ['host.docker.internal:host-gateway'],
    });
    expect(args).toEqual([
      'run',
      '--rm',
      '--add-host=host.docker.internal:host-gateway',
      '--volume=/repo:/apps',
      '--workdir=/apps',
      'alpine:3',
      'echo',
      'a b',
      '--flag',
    ]);
  });

  it('adds read-only mounts, the entrypoint and the names of env variables', () => {
    expect(
      dockerRunArgs('alpine:3', ['-lc', 'echo 1'], {
        workdir: '/w',
        mounts: [{ host: '/a', container: '/b', readonly: true }],
        addHosts: [],
        entrypoint: '/bin/sh',
        envNames: ['PW'],
      }),
    ).toEqual([
      'run',
      '--rm',
      '--volume=/a:/b:ro',
      '--workdir=/w',
      '--entrypoint=/bin/sh',
      '--env=PW',
      'alpine:3',
      '-lc',
      'echo 1',
    ]);
  });

  it('keeps hostile values as single arguments', () => {
    const args = dockerRunArgs('img; touch /x', ['$(id)', '--opt=a b'], {
      workdir: '/w d',
      mounts: [{ host: '/my repo', container: '/apps' }],
      addHosts: ['h:g;x'],
      entrypoint: '/bin/sh -c',
    });
    expect(args).toContain('img; touch /x');
    expect(args).toContain('--volume=/my repo:/apps');
    expect(args).toContain('--workdir=/w d');
    expect(args).toContain('--entrypoint=/bin/sh -c');
    expect(args).toContain('$(id)');
  });
});

describe('assertDockerAvailable', () => {
  it('runs docker version', async () => {
    const { context, calls } = make();
    await assertDockerAvailable(context);
    expect(calls[0]).toMatchObject({ file: 'docker', args: ['version'] });
  });

  it('maps a failure to ENODOCKER', async () => {
    const { context } = make(() => {
      throw new Error('spawn docker ENOENT');
    });
    await expect(assertDockerAvailable(context)).rejects.toMatchObject({
      code: 'ENODOCKER',
    });
  });
});

describe('DockerImage.pull', () => {
  it('delegates to docker pull', async () => {
    const { image, calls } = make();
    await image.pull();
    expect(calls[0]).toMatchObject({
      file: 'docker',
      args: ['pull', 'alpine:3'],
    });
  });

  it('maps a runner error to SemanticReleaseError EIMAGEPULLFAILED', async () => {
    const { image } = make(() => {
      throw new Error('boom');
    });
    await expect(image.pull()).rejects.toMatchObject({
      code: 'EIMAGEPULLFAILED',
    });
  });

  it('does not put credentials from the failure in the details', async () => {
    const { image } = make(() => {
      throw new Error('pull https://u:tok3nvalue@reg.example.test/x failed');
    });
    const failure = await image.pull().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(
      JSON.stringify(failure, Object.getOwnPropertyNames(failure)),
    ).not.toContain('tok3nvalue');
  });
});

describe('DockerImage.run', () => {
  it('uses the injected runner, mounts the repo at /apps and returns stdout', async () => {
    const { image, calls } = make(() => 'ok');
    expect(await image.run(['echo', 'hi'])).toBe('ok');
    expect(calls[0]?.args).toContain('--volume=/repo:/apps');
    expect(calls[0]?.args).toContain('hi');
    expect(calls[0]?.options?.cwd).toBe('/repo');
  });

  it('sets no entrypoint by default and the default add-host and workdir', async () => {
    const { image, calls } = make();
    await image.run(['echo']);
    expect(calls[0]?.args.some((a) => a.startsWith('--entrypoint'))).toBe(
      false,
    );
    expect(calls[0]?.args).toContain(
      '--add-host=host.docker.internal:host-gateway',
    );
    expect(calls[0]?.args).toContain('--workdir=/apps');
  });

  it('sets the entrypoint and passes env values to the runner, not the arguments', async () => {
    const { image, calls, lines } = make();
    await image.run(['-lc', 'true'], {
      entrypoint: '/bin/sh',
      env: { SECRET_TOKEN: 'placeholder$x' },
    });
    expect(calls[0]?.args).toContain('--entrypoint=/bin/sh');
    expect(calls[0]?.args).toContain('--env=SECRET_TOKEN');
    expect(calls[0]?.options?.env).toEqual({ SECRET_TOKEN: 'placeholder$x' });
    expect([...(calls[0]?.args ?? []), ...lines].join('\n')).not.toContain(
      'placeholder',
    );
  });

  it('honours workdir, mounts and add-host overrides', async () => {
    const { image, calls } = make(undefined, {
      workdir: '/work',
      mounts: [{ host: '/data', container: '/mnt', readonly: true }],
      addHosts: ['db:10.0.0.1'],
    });
    await image.run(['echo']);
    const args = calls[0]?.args ?? [];
    expect(args).toContain('--workdir=/work');
    expect(args).toContain('--volume=/data:/mnt:ro');
    expect(args).toContain('--add-host=db:10.0.0.1');
    expect(args.join(' ')).not.toContain('/repo');
    expect(args.join(' ')).not.toContain('host.docker.internal');
  });

  it('logs the runner error message and rethrows', async () => {
    const { image, lines } = make(() => {
      throw new Error('exploded');
    });
    await expect(image.run(['echo'])).rejects.toThrow('exploded');
    expect(lines).toContain('exploded');
  });

  it('logs and rethrows without credentials in the command or error', async () => {
    const url = 'oci://u:tok3nvalue@localhost:5000/charts';
    const { image, lines } = make(() => {
      throw new Error(`push to ${url} failed`);
    });
    const failure = await image.run(['push', url]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(lines.join('\n')).not.toContain('tok3nvalue');
    expect(String((failure as Error).message)).not.toContain('tok3nvalue');
  });

  it('with env keeps short values from mangling the message', async () => {
    const { image } = make(() => {
      throw new Error('Command failed: unauthorized');
    });
    await expect(image.run(['true'], { env: { PW: 'a' } })).rejects.toThrow(
      'Command failed: unauthorized',
    );
  });

  it('with env replaces an empty failure with a fixed message', async () => {
    const { image } = make(() => {
      throw new Error('');
    });
    await expect(
      image.run(['true'], { env: { PW: 'secretvalue' } }),
    ).rejects.toThrow('environment variable(s) PW');
  });

  it('with env scrubs encoded forms and keeps code and status', async () => {
    const value = 'p@ss word';
    const { image } = make(() => {
      throw Object.assign(
        new Error(
          `bad ${encodeURIComponent(value)} and ${Buffer.from(value).toString('base64')} and ${value}`,
        ),
        { code: 'E_X', status: 9 },
      );
    });
    const failure = await image.run(['true'], { env: { PW: value } }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toMatchObject({
      message: 'bad *** and *** and ***',
      code: 'E_X',
      status: 9,
    });
  });

  it('with env names the code of a spawn failure and never the value', async () => {
    const { image, lines } = make(() => {
      throw Object.assign(new Error('Received sec\u0000ret'), {
        code: 'ERR_INVALID_ARG_VALUE',
      });
    });
    const failure = await image
      .run(['true'], { env: { OCI_PASSWORD: 'sec\u0000ret' } })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(String((failure as Error).message)).toContain(
      '(ERR_INVALID_ARG_VALUE)',
    );
    expect(
      [...lines, String((failure as Error).message)].join('\n'),
    ).not.toContain('sec');
  });
});
