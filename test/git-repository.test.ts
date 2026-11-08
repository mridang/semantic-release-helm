import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { GitRepository } from '../src/git-repository.js';
import { git, initRepo } from './utils/git.js';
import { fakeRunner, recordingLogger } from './utils/runner.js';
import { withTempDir } from './utils/tmpdir.js';

const fails = () => {
  throw new Error('nope');
};

describe('GitRepository.open with a fake runner', () => {
  it('maps a missing git to ENOGIT', async () => {
    const { run } = fakeRunner(fails);
    const { logger } = recordingLogger();
    await expect(
      GitRepository.open({ logger, cwd: '/repo', run }),
    ).rejects.toMatchObject({ code: 'ENOGIT' });
  });

  it('maps a directory outside a repository to ENOTGITREPO', async () => {
    const { run } = fakeRunner((call) => {
      if (call.args[0] === 'rev-parse') {
        throw new Error('not a repo');
      }
      return '';
    });
    const { logger } = recordingLogger();
    await expect(
      GitRepository.open({ logger, cwd: '/repo', run }),
    ).rejects.toMatchObject({ code: 'ENOTGITREPO' });
  });

  it('maps an unknown remote to ENOREMOTE without leaking a credential in its name', async () => {
    const { run } = fakeRunner((call) => {
      if (call.args[0] === 'remote') {
        throw new Error('no such remote');
      }
      return '';
    });
    const { logger } = recordingLogger();
    const repository = await GitRepository.open({ logger, cwd: '/repo', run });
    const failure = await repository
      .remote('https://x:tok3nvalue@host/o/r.git')
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(failure).toMatchObject({ code: 'ENOREMOTE' });
    expect(
      JSON.stringify(failure, Object.getOwnPropertyNames(failure)),
    ).not.toContain('tok3nvalue');
  });

  it('returns a remote with its parsed url', async () => {
    const { run } = fakeRunner((call) =>
      call.args[0] === 'remote' ? 'https://github.com/o/r.git\n' : '',
    );
    const { logger } = recordingLogger();
    const repository = await GitRepository.open({ logger, cwd: '/repo', run });
    const remote = await repository.remote('origin');
    expect(remote.name).toBe('origin');
    expect(remote.url.webBase()).toBe('https://github.com/o/r');
  });
});

describe('GitRepository with real git', () => {
  const open = async (cwd: string) => {
    const { logger } = recordingLogger();
    return GitRepository.open({ logger, cwd });
  };

  it(
    'opens a repository and finds its remote',
    withTempDir(async (dir) => {
      initRepo(dir);
      git(dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
      const repository = await open(dir);
      expect((await repository.remote('origin')).name).toBe('origin');
      await expect(repository.remote('nope')).rejects.toMatchObject({
        code: 'ENOREMOTE',
      });
    }),
  );

  it(
    'refuses a directory that is not a repository',
    withTempDir(async (dir) => {
      await expect(open(dir)).rejects.toMatchObject({ code: 'ENOTGITREPO' });
    }),
  );

  it(
    'creates an orphan branch in a path with spaces when none exists',
    withTempDir(async (dir) => {
      initRepo(dir);
      git(dir, 'commit', '--allow-empty', '--quiet', '-m', 'init');
      const wt = path.join(dir, 'work tree');
      const worktree = await (await open(dir)).createWorktree(wt, 'gh-pages');
      expect(git(wt, 'symbolic-ref', '--short', 'HEAD').trim()).toBe(
        'gh-pages',
      );
      expect(worktree.branch.name).toBe('gh-pages');
    }),
  );

  it(
    'reuses an existing local branch',
    withTempDir(async (dir) => {
      initRepo(dir);
      git(dir, 'commit', '--allow-empty', '--quiet', '-m', 'init');
      git(dir, 'branch', 'pages');
      const wt = path.join(dir, 'wt');
      await (await open(dir)).createWorktree(wt, 'pages');
      expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('pages');
    }),
  );

  it(
    'prefers the remote branch, and a stale worktree can be removed',
    withTempDir(async (dir) => {
      initRepo(dir);
      git(dir, 'commit', '--allow-empty', '--quiet', '-m', 'init');
      const bare = path.join(dir, 'bare.git');
      git(dir, 'init', '--quiet', '--bare', bare);
      git(dir, 'remote', 'add', 'origin', bare);
      git(dir, 'push', '--quiet', 'origin', 'HEAD:refs/heads/pages');
      const repository = await open(dir);
      const remote = await repository.remote('origin');
      const fetched = await remote.fetch('pages');
      expect(fetched).toEqual({ name: 'pages', remote: 'origin' });
      const wt = path.join(dir, 'wt');
      const worktree = await repository.createWorktree(wt, 'pages', fetched);
      fs.writeFileSync(path.join(wt, 'f.txt'), 'f');
      await worktree.commit('m', { name: 'a', email: 'a@b.c' });
      await remote.push(worktree.branch);
      expect(git(bare, 'log', '-1', '--format=%s', 'pages').trim()).toBe('m');
      expect(await repository.removeWorktree(wt)).toBe(true);
      expect(await repository.removeWorktree(wt)).toBe(false);
    }),
  );
});
