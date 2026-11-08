import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { Remote } from '../src/remote.js';
import { RemoteUrl } from '../src/remote-url.js';
import { git, initRepo } from './utils/git.js';
import { fakeRunner, recordingLogger } from './utils/runner.js';
import { withTempDir } from './utils/tmpdir.js';

const remoteOf = (
  cwd: string,
  name: string,
  answer?: Parameters<typeof fakeRunner>[0],
) => {
  const { run, calls } = fakeRunner(answer);
  const { logger } = recordingLogger();
  const remote = new Remote({
    name,
    url: RemoteUrl.parse('https://github.com/o/r.git'),
    logger,
    cwd,
    run,
  });
  return { remote, calls };
};

const fails = () => {
  throw new Error('nope');
};

describe('Remote with a fake runner', () => {
  it('exposes its name and url', () => {
    const { remote } = remoteOf('/repo', 'origin');
    expect(remote.name).toBe('origin');
    expect(remote.url.webBase()).toBe('https://github.com/o/r');
  });

  it('passes the name as a separate argument and reports reachability by status', async () => {
    const hostile = 'a b; $(id)';
    const ok = remoteOf('/repo', hostile);
    expect(await ok.remote.isReachable()).toBe(true);
    expect(ok.calls[0]?.args).toEqual(['ls-remote', '--heads', hostile]);
    expect(await remoteOf('/repo', 'origin', fails).remote.isReachable()).toBe(
      false,
    );
  });

  it('returns the fetched branch, or undefined when the fetch fails', async () => {
    const ok = remoteOf('/repo', 'origin');
    expect(await ok.remote.fetch('gh-pages')).toEqual({
      name: 'gh-pages',
      remote: 'origin',
    });
    expect(ok.calls[0]?.args).toEqual(['fetch', 'origin', 'gh-pages']);
    expect(
      await remoteOf('/repo', 'origin', fails).remote.fetch('gh-pages'),
    ).toBeUndefined();
  });

  it('pushes a branch from its working tree, or from the repository', async () => {
    const { remote, calls } = remoteOf('/repo', 'origin');
    await remote.push({ name: 'pages', directory: '/wt' });
    await remote.push({ name: 'pages' });
    expect(calls.map((c) => c.args)).toEqual([
      ['-C', '/wt', 'push', 'origin', 'pages'],
      ['push', 'origin', 'pages'],
    ]);
  });
});

describe('Remote with real git', () => {
  it(
    'is reachable when the repository exists and not when it is missing',
    withTempDir(async (dir) => {
      initRepo(dir);
      const bare = path.join(dir, 'bare.git');
      git(dir, 'init', '--quiet', '--bare', bare);
      const { logger } = recordingLogger();
      const make = (name: string) =>
        new Remote({
          name,
          url: RemoteUrl.parse(name),
          logger,
          cwd: dir,
        });
      expect(await make(bare).isReachable()).toBe(true);
      expect(await make(path.join(dir, 'missing.git')).isReachable()).toBe(
        false,
      );
    }),
  );
});
