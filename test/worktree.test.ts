import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { Worktree } from '../src/worktree.js';
import { git, initRepo } from './utils/git.js';
import { fakeRunner, recordingLogger } from './utils/runner.js';
import { withTempDir } from './utils/tmpdir.js';

const author = { name: 'Bot "x"; $(id)', email: 'bot@example.test' };

const real = (dir: string) => {
  const { logger, lines } = recordingLogger();
  return {
    worktree: new Worktree({
      directory: dir,
      branch: { name: 'main' },
      logger,
      cwd: dir,
    }),
    lines,
  };
};

describe('Worktree with real git', () => {
  it(
    'lists changes, including untracked files',
    withTempDir(async (dir) => {
      initRepo(dir);
      await writeFile(path.join(dir, 'a.txt'), 'a');
      const { worktree } = real(dir);
      expect(await worktree.changes()).toEqual([
        { status: '??', path: 'a.txt' },
      ]);
    }),
  );

  it(
    'returns undefined and logs when there is nothing to commit',
    withTempDir(async (dir) => {
      initRepo(dir);
      const { worktree, lines } = real(dir);
      expect(await worktree.commit('msg', author)).toBeUndefined();
      expect(lines).toContain('gh-pages: no changes to commit');
    }),
  );

  it(
    'stages everything and returns the commit, with the author and message intact',
    withTempDir(async (dir) => {
      initRepo(dir);
      await writeFile(path.join(dir, 'a.txt'), 'a');
      const { worktree } = real(dir);
      const commit = await worktree.commit('docs: a message [skip ci]', author);
      expect(commit).toEqual({
        sha: git(dir, 'rev-parse', 'HEAD').trim(),
        message: 'docs: a message [skip ci]',
      });
      expect(git(dir, 'log', '-1', '--format=%an|%ae|%s').trim()).toBe(
        'Bot "x"; $(id)|bot@example.test|docs: a message [skip ci]',
      );
    }),
  );

  it(
    'commits into an unborn branch',
    withTempDir(async (dir) => {
      initRepo(dir);
      git(dir, 'checkout', '--orphan', 'pages');
      await writeFile(path.join(dir, 'index.yaml'), 'x');
      const commit = await real(dir).worktree.commit('m', author);
      expect(commit?.message).toBe('m');
    }),
  );

  it(
    'reports its directory and its branch with the directory attached',
    withTempDir(async (dir) => {
      const { worktree } = real(dir);
      expect(worktree.directory).toBe(dir);
      expect(worktree.branch).toEqual({ name: 'main', directory: dir });
    }),
  );

  it(
    'removes itself, and says so when there is nothing to remove',
    withTempDir(async (dir) => {
      initRepo(dir);
      git(dir, 'commit', '--allow-empty', '--quiet', '-m', 'init');
      const wt = path.join(dir, 'wt');
      git(dir, 'worktree', 'add', '--quiet', '--detach', wt);
      const { logger } = recordingLogger();
      const tree = new Worktree({
        directory: wt,
        branch: { name: 'x' },
        logger,
        cwd: dir,
      });
      expect(await tree.remove()).toBe(true);
      expect(await tree.remove()).toBe(false);
    }),
  );
});

describe('Worktree with a fake runner', () => {
  it('rethrows an unexpected failure of the staged check', async () => {
    const { run } = fakeRunner((call) => {
      if (call.args.includes('--quiet')) {
        throw Object.assign(new Error('bad'), { status: 128 });
      }
      return '';
    });
    const { logger } = recordingLogger();
    const worktree = new Worktree({
      directory: '/w',
      branch: { name: 'x' },
      logger,
      cwd: '/repo',
      run,
    });
    await expect(worktree.commit('m', author)).rejects.toThrow('bad');
  });

  it('passes the author and message as separate arguments', async () => {
    const { run, calls } = fakeRunner((call) => {
      if (call.args.includes('--quiet')) {
        throw Object.assign(new Error('staged'), { status: 1 });
      }
      return 'abc123';
    });
    const { logger } = recordingLogger();
    const worktree = new Worktree({
      directory: '/w',
      branch: { name: 'x' },
      logger,
      cwd: '/repo',
      run,
    });
    await worktree.commit('m "q"', { name: 'a b', email: 'e@x.y' });
    const commit = calls.find((c) => c.args.includes('commit'));
    expect(commit?.args).toEqual([
      '-C',
      '/w',
      '-c',
      'user.name=a b',
      '-c',
      'user.email=e@x.y',
      'commit',
      '--message=m "q"',
    ]);
  });
});
