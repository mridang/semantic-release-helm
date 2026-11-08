import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { commitIfStaged, hasStagedChanges } from '../src/gh-pages.js';
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
