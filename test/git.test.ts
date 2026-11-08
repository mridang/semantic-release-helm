import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { GitClient } from '../src/git.js';
import { fakeRunner, recordingLogger } from './utils/runner.js';
import { withTempDir } from './utils/tmpdir.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

const initRepo = (dir: string): void => {
  git(dir, 'init', '--quiet');
  git(dir, 'config', 'user.name', 'init');
  git(dir, 'config', 'user.email', 'init@example.test');
};

const real = (cwd: string) => {
  const { logger, lines } = recordingLogger();
  return { client: new GitClient({ logger, cwd }), lines };
};

describe('GitClient with a fake runner', () => {
  const fake = (answer?: Parameters<typeof fakeRunner>[0]) => {
    const { run, calls } = fakeRunner(answer);
    const { logger, lines } = recordingLogger();
    return {
      client: new GitClient({ logger, cwd: '/repo', run }),
      calls,
      lines,
    };
  };
  const fails = () => {
    throw new Error('nope');
  };

  it('maps each failed check to its coded error', async () => {
    const { client } = fake(fails);
    await expect(client.assertAvailable()).rejects.toMatchObject({
      code: 'ENOGIT',
    });
    await expect(client.assertRepository()).rejects.toMatchObject({
      code: 'ENOTGITREPO',
    });
    await expect(client.remoteUrl('origin')).rejects.toMatchObject({
      code: 'ENOREMOTE',
    });
    await expect(client.assertReachable('origin')).rejects.toMatchObject({
      code: 'EREMOTEACCESS',
    });
  });

  it('never puts a credential from a remote name into an error message', async () => {
    const { client } = fake(fails);
    const failure = await client
      .assertReachable('https://x:tok3nvalue@host/o/r.git')
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(
      JSON.stringify(failure, Object.getOwnPropertyNames(failure)),
    ).not.toContain('tok3nvalue');
  });

  it('passes values as separate arguments to git', async () => {
    const { client, calls } = fake(() => 'out');
    const hostile = 'a b; $(id) "q"';
    await client.remoteUrl(hostile);
    await client.push(hostile, hostile, hostile);
    await client.fetchBranch(hostile, hostile);
    expect(calls.map((c) => [c.file, ...c.args])).toEqual([
      ['git', 'remote', 'get-url', hostile],
      ['git', '-C', hostile, 'push', hostile, hostile],
      ['git', 'fetch', hostile, hostile],
    ]);
  });

  it('returns the remote url, and booleans for tolerated failures', async () => {
    const ok = fake(() => 'https://github.com/o/r.git\n');
    expect(await ok.client.remoteUrl('origin')).toBe(
      'https://github.com/o/r.git',
    );
    expect(await ok.client.removeWorktree('/w')).toBe(true);
    expect(await ok.client.fetchBranch('origin', 'gh-pages')).toBe(true);
    const bad = fake(fails);
    expect(await bad.client.removeWorktree('/w')).toBe(false);
    expect(await bad.client.fetchBranch('origin', 'gh-pages')).toBe(false);
  });

  it('reports the status, stages, and summarises with the right arguments', async () => {
    const { client, calls } = fake();
    await client.status('/w', true);
    await client.status('/w');
    await client.stageAll('/w');
    await client.stagedSummary('/w');
    expect(calls.map((c) => c.args)).toEqual([
      ['-C', '/w', 'status', '--untracked-files=all'],
      ['-C', '/w', 'status'],
      ['-C', '/w', 'add', '.'],
      ['-C', '/w', 'diff', '--staged', '--stat'],
    ]);
  });

  it('rethrows an unexpected failure of the staged check', async () => {
    const { client } = fake(() => {
      throw Object.assign(new Error('bad'), { status: 128 });
    });
    await expect(client.hasStagedChanges('/w')).rejects.toThrow('bad');
  });
});

describe('GitClient with real git', () => {
  it(
    'hasStagedChanges is false for a clean tree and true once a file is staged',
    withTempDir(async (dir) => {
      initRepo(dir);
      const { client } = real(dir);
      expect(await client.hasStagedChanges(dir)).toBe(false);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
      expect(await client.hasStagedChanges(dir)).toBe(false);
      git(dir, 'add', '.');
      expect(await client.hasStagedChanges(dir)).toBe(true);
    }),
  );

  it(
    'hasStagedChanges throws when the path is not a git repository',
    withTempDir(async (dir) => {
      const { client } = real(dir);
      await expect(
        client.hasStagedChanges(path.join(dir, 'missing')),
      ).rejects.toThrow();
    }),
  );

  describe('commitStaged', () => {
    const author = { name: 'Bot "x"; $(id)', email: 'bot@example.test' };

    it(
      'logs and does not commit when nothing is staged',
      withTempDir(async (dir) => {
        initRepo(dir);
        const { client, lines } = real(dir);
        expect(await client.commitStaged(dir, 'msg', author)).toBe(false);
        expect(lines).toContain('gh-pages: no changes to commit');
      }),
    );

    it(
      'commits staged changes with the author and message intact',
      withTempDir(async (dir) => {
        initRepo(dir);
        fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
        git(dir, 'add', '.');
        const { client } = real(dir);
        expect(
          await client.commitStaged(dir, 'docs: a message [skip ci]', author),
        ).toBe(true);
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
        fs.writeFileSync(path.join(dir, 'index.yaml'), 'x');
        git(dir, 'add', '.');
        const { client } = real(dir);
        expect(await client.commitStaged(dir, 'm', author)).toBe(true);
      }),
    );
  });

  describe('addWorktree', () => {
    it(
      'creates an orphan branch in a path with spaces when none exists',
      withTempDir(async (dir) => {
        initRepo(dir);
        git(dir, 'commit', '--allow-empty', '--quiet', '-m', 'init');
        const wt = path.join(dir, 'work tree');
        await real(dir).client.addWorktree(wt, 'origin', 'gh-pages');
        expect(git(wt, 'symbolic-ref', '--short', 'HEAD').trim()).toBe(
          'gh-pages',
        );
      }),
    );

    it(
      'reuses an existing local branch',
      withTempDir(async (dir) => {
        initRepo(dir);
        git(dir, 'commit', '--allow-empty', '--quiet', '-m', 'init');
        git(dir, 'branch', 'pages');
        const wt = path.join(dir, 'wt');
        await real(dir).client.addWorktree(wt, 'origin', 'pages');
        expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
          'pages',
        );
      }),
    );

    it(
      'prefers the remote branch and can push to it',
      withTempDir(async (dir) => {
        initRepo(dir);
        git(dir, 'commit', '--allow-empty', '--quiet', '-m', 'init');
        const bare = path.join(dir, 'bare.git');
        git(dir, 'init', '--quiet', '--bare', bare);
        git(dir, 'remote', 'add', 'origin', bare);
        git(dir, 'push', '--quiet', 'origin', 'HEAD:refs/heads/pages');
        const { client } = real(dir);
        expect(await client.fetchBranch('origin', 'pages')).toBe(true);
        const wt = path.join(dir, 'wt');
        await client.addWorktree(wt, 'origin', 'pages');
        fs.writeFileSync(path.join(wt, 'f.txt'), 'f');
        await client.stageAll(wt);
        await client.commitStaged(wt, 'm', { name: 'a', email: 'a@b.c' });
        await client.push(wt, 'origin', 'pages');
        expect(git(bare, 'log', '-1', '--format=%s', 'pages').trim()).toBe('m');
        expect(await client.removeWorktree(wt)).toBe(true);
      }),
    );
  });

  describe('checks', () => {
    it(
      'assertReachable passes for a reachable remote and fails for a missing one',
      withTempDir(async (dir) => {
        initRepo(dir);
        const bare = path.join(dir, 'bare.git');
        git(dir, 'init', '--quiet', '--bare', bare);
        const { client } = real(dir);
        await expect(client.assertReachable(bare)).resolves.toBeUndefined();
        await expect(
          client.assertReachable(path.join(dir, 'missing.git')),
        ).rejects.toMatchObject({ code: 'EREMOTEACCESS' });
      }),
    );

    it(
      'assertRepository, assertAvailable and remoteUrl work in a repository',
      withTempDir(async (dir) => {
        initRepo(dir);
        git(dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
        const { client } = real(dir);
        await expect(client.assertAvailable()).resolves.toBeUndefined();
        await expect(client.assertRepository()).resolves.toBeUndefined();
        expect(await client.remoteUrl('origin')).toBe(
          'https://github.com/o/r.git',
        );
        await expect(client.remoteUrl('nope')).rejects.toMatchObject({
          code: 'ENOREMOTE',
        });
      }),
    );
  });
});
