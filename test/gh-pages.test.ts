import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  buildWorktreeAddCommand,
  commitIfStaged,
  hasStagedChanges,
  isRemoteReachable,
  releaseBase,
  repositoryWebBase,
} from '../src/gh-pages.js';
import { withTempDir } from './utils/tmpdir.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

const logger = () => {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      log: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
    },
  };
};

const initRepo = (dir: string): void => {
  git(dir, 'init', '--quiet');
  git(dir, 'config', 'user.name', 'init');
  git(dir, 'config', 'user.email', 'init@example.test');
};

describe('hasStagedChanges', () => {
  it(
    'is false for a clean tree and true once a file is staged',
    withTempDir((dir) => {
      initRepo(dir);
      expect(hasStagedChanges(dir)).toBe(false);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
      expect(hasStagedChanges(dir)).toBe(false);
      git(dir, 'add', '.');
      expect(hasStagedChanges(dir)).toBe(true);
    }),
  );

  it('throws when the path is not a git repository', () => {
    expect(() => hasStagedChanges('/nonexistent-path-for-test')).toThrow();
  });
});

describe('commitIfStaged', () => {
  const author = { name: 'Bot "x"; $(id)', email: 'bot@example.test' };

  it(
    'logs and does not commit when nothing is staged',
    withTempDir((dir) => {
      initRepo(dir);
      const { lines, logger: l } = logger();
      expect(commitIfStaged(dir, dir, 'msg', author, l)).toBe(false);
      expect(lines).toEqual(['gh-pages: no changes to commit']);
    }),
  );

  it(
    'commits staged changes with the quoted author and message',
    withTempDir((dir) => {
      initRepo(dir);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
      git(dir, 'add', '.');
      const { logger: l } = logger();
      expect(
        commitIfStaged(dir, dir, 'docs: a message [skip ci]', author, l),
      ).toBe(true);
      expect(git(dir, 'log', '-1', '--format=%an|%ae|%s').trim()).toBe(
        'Bot "x"; $(id)|bot@example.test|docs: a message [skip ci]',
      );
    }),
  );

  it(
    'commits into an unborn branch',
    withTempDir((dir) => {
      initRepo(dir);
      git(dir, 'checkout', '--orphan', 'pages');
      fs.writeFileSync(path.join(dir, 'index.yaml'), 'x');
      git(dir, 'add', '.');
      const { logger: l } = logger();
      expect(commitIfStaged(dir, dir, 'm', author, l)).toBe(true);
    }),
  );
});

describe('repositoryWebBase', () => {
  it.each([
    ['https://github.com/o/r.git', 'https://github.com/o/r'],
    ['https://github.com/o/r', 'https://github.com/o/r'],
    ['git@github.com:o/r.git', 'https://github.com/o/r'],
    ['ghes.corp:org/repo.git', 'https://ghes.corp/org/repo'],
    ['ghes.corp:8443/org/repo.git', 'https://ghes.corp/8443/org/repo'],
    ['ssh://git@github.com/o/r.git', 'https://github.com/o/r'],
    ['ssh://git@github.com:2222/o/r.git', 'https://github.com/o/r'],
    ['git://github.com/o/r.git', 'https://github.com/o/r'],
    ['https://ghes.corp:8443/o/r.git', 'https://ghes.corp:8443/o/r'],
    ['http://ghes.corp:8080/o/r', 'http://ghes.corp:8080/o/r'],
    ['http://git.internal:3000/o/r.git', 'http://git.internal:3000/o/r'],
    [
      'https://x-access-token:TOKEN@github.com/o/r.git',
      'https://github.com/o/r',
    ],
    ['https://user@ghe.example.test/o/r.git/', 'https://ghe.example.test/o/r'],
    ['git@ghe.example.test:o/r.git\n', 'https://ghe.example.test/o/r'],
  ])('maps %s', (remote, expected) => {
    expect(repositoryWebBase(remote)).toBe(expected);
  });

  it.each([
    ['file:///srv/git/r.git'],
    ['/srv/git/r.git'],
    ['../r.git'],
    ['r.git'],
    [''],
    ['https://github.com/'],
    ['git@gh-work:o/r.git'],
    ['C:\\path\\repo'],
    ['C:/path/repo'],
    ['git@[::1]:o/r'],
    ['file://server/share/repo'],
    ['ftp://example.com/o/r'],
  ])('derives nothing from %j', (remote) => {
    expect(repositoryWebBase(remote)).toBeUndefined();
  });

  it('never lets a token reach the result', () => {
    expect(
      repositoryWebBase('https://x-access-token:SECRET@github.com/o/r.git'),
    ).not.toContain('SECRET');
  });
});

describe('releaseBase', () => {
  it.each([
    ['git@github.com:o/r.git', undefined, 'https://github.com/o/r'],
    [
      'git@github.com:o/r.git',
      'https://github.com/x/y',
      'https://github.com/o/r',
    ],
    ['git@gh-work:o/r.git', 'https://github.com/o/r', 'https://github.com/o/r'],
    ['/srv/git/r.git', 'https://github.com/o/r', 'https://github.com/o/r'],
    [
      'git@gitlab.com:o/r.git',
      'https://github.com/o/r',
      'https://github.com/o/r',
    ],
    ['git@gitlab.com:o/r.git', undefined, undefined],
    ['git@ghes.corp:o/r.git', 'https://ghes.corp/o/r', 'https://ghes.corp/o/r'],
    ['git@ghes.corp:o/r.git', 'git@ghes.corp:o/r.git', 'https://ghes.corp/o/r'],
    ['/srv/git/r.git', undefined, undefined],
  ])(
    'remote %s with repositoryUrl %s gives %s',
    (remote, repositoryUrl, expected) => {
      expect(releaseBase(remote, repositoryUrl)).toBe(expected);
    },
  );
});

describe('buildWorktreeAddCommand', () => {
  it('quotes the worktree, remote and branch', () => {
    const cmd = buildWorktreeAddCommand('/my repo/wt', 'up stream', 'pages;id');
    expect(cmd).toContain("'/my repo/wt'");
    expect(cmd).toContain("'refs/remotes/up stream/pages;id'");
    expect(cmd).toContain("'pages;id'");
    expect(cmd).not.toMatch(/ pages;id\b/);
  });

  it(
    'creates an orphan branch in a path with spaces when none exists',
    withTempDir((dir) => {
      initRepo(dir);
      git(dir, 'commit', '--allow-empty', '--quiet', '-m', 'init');
      const wt = path.join(dir, 'work tree');
      execFileSync(
        'sh',
        ['-c', buildWorktreeAddCommand(wt, 'origin', 'gh-pages')],
        { cwd: dir },
      );
      expect(git(wt, 'symbolic-ref', '--short', 'HEAD').trim()).toBe(
        'gh-pages',
      );
    }),
  );

  it(
    'reuses an existing local branch',
    withTempDir((dir) => {
      initRepo(dir);
      git(dir, 'commit', '--allow-empty', '--quiet', '-m', 'init');
      git(dir, 'branch', 'pages');
      const wt = path.join(dir, 'wt');
      execFileSync(
        'sh',
        ['-c', buildWorktreeAddCommand(wt, 'origin', 'pages')],
        {
          cwd: dir,
        },
      );
      expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('pages');
    }),
  );
});

describe('isRemoteReachable', () => {
  it(
    'is true for a reachable remote and false for a missing one',
    withTempDir((dir) => {
      initRepo(dir);
      const bare = path.join(dir, 'bare.git');
      git(dir, 'init', '--quiet', '--bare', bare);
      expect(isRemoteReachable(bare, dir)).toBe(true);
      expect(isRemoteReachable(path.join(dir, 'missing.git'), dir)).toBe(false);
    }),
  );
});
