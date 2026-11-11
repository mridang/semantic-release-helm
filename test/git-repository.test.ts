import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from './utils/fs.js';
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
      .then(() => undefined)
      .catch((error: unknown) => error);
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
      await initRepo(dir);
      await git(dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
      const repository = await open(dir);
      const remote = await repository.remote('origin');
      expect(remote.name).toBe('origin');
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
      await initRepo(dir);
      await git(dir, 'commit', '--allow-empty', '--quiet', '-m', 'init');
      const wt = path.join(dir, 'work tree');
      const repository = await open(dir);
      const worktree = await repository.createWorktree(wt, 'gh-pages');
      const head = await git(wt, 'symbolic-ref', '--short', 'HEAD');
      expect(head.trim()).toBe('gh-pages');
      expect(worktree.branch.name).toBe('gh-pages');
    }),
  );

  it(
    'reuses an existing local branch',
    withTempDir(async (dir) => {
      await initRepo(dir);
      await git(dir, 'commit', '--allow-empty', '--quiet', '-m', 'init');
      await git(dir, 'branch', 'pages');
      const wt = path.join(dir, 'wt');
      const repository = await open(dir);
      await repository.createWorktree(wt, 'pages');
      const head = await git(wt, 'rev-parse', '--abbrev-ref', 'HEAD');
      expect(head.trim()).toBe('pages');
    }),
  );

  it(
    'prefers the remote branch, and a stale worktree can be removed',
    withTempDir(async (dir) => {
      await initRepo(dir);
      await git(dir, 'commit', '--allow-empty', '--quiet', '-m', 'init');
      const bare = path.join(dir, 'bare.git');
      await git(dir, 'init', '--quiet', '--bare', bare);
      await git(dir, 'remote', 'add', 'origin', bare);
      await git(dir, 'push', '--quiet', 'origin', 'HEAD:refs/heads/pages');
      const repository = await open(dir);
      const remote = await repository.remote('origin');
      const fetched = await remote.fetch('pages');
      expect(fetched).toEqual({ name: 'pages', remote: 'origin' });
      const wt = path.join(dir, 'wt');
      const worktree = await repository.createWorktree(wt, 'pages', fetched);
      await fs.writeFile(path.join(wt, 'f.txt'), 'f');
      await worktree.commit('m', { name: 'a', email: 'a@b.c' });
      await remote.push(worktree.branch);
      const subject = await git(bare, 'log', '-1', '--format=%s', 'pages');
      expect(subject.trim()).toBe('m');
      expect(await repository.removeWorktree(wt)).toBe(true);
      expect(await repository.removeWorktree(wt)).toBe(false);
    }),
  );

  it(
    'finds a remote branch in a single-branch clone',
    withTempDir(async (dir) => {
      const upstream = path.join(dir, 'upstream');
      await fs.mkdir(upstream);
      await initRepo(upstream);
      await git(upstream, 'commit', '--allow-empty', '--quiet', '-m', 'init');
      await git(upstream, 'checkout', '--quiet', '-b', 'pages');
      await fs.writeFile(path.join(upstream, 'index.yaml'), 'entries: {}\n');
      await git(upstream, 'add', '.');
      await git(upstream, 'commit', '--quiet', '-m', 'pages');
      await git(upstream, 'checkout', '--quiet', '-');
      const clone = path.join(dir, 'clone');
      await git(dir, 'clone', '--quiet', '--single-branch', upstream, clone);
      const repository = await open(clone);
      const remote = await repository.remote('origin');
      const fetched = await remote.fetch('pages');
      expect(fetched).toEqual({ name: 'pages', remote: 'origin' });
      const wt = path.join(dir, 'wt');
      await repository.createWorktree(wt, 'pages', fetched);
      expect(await pathExists(path.join(wt, 'index.yaml'))).toBe(true);
    }),
  );
});
