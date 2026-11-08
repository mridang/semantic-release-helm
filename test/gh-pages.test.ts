import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import * as yaml from 'yaml';
// noinspection ES6PreferShortImport
import { GitClient } from '../src/git.js';
import {
  planGhPages,
  publishGhPages,
  releaseBase,
  repositoryWebBase,
} from '../src/gh-pages.js';
import { recordingLogger } from './utils/runner.js';
import { withTempDir } from './utils/tmpdir.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

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

/**
 * A repository with a chart, one packaged chart, and a bare remote named
 * origin.
 */
function scenario(base: string): { repo: string; remote: string } {
  const repo = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  fs.mkdirSync(path.join(repo, 'app'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'dist', 'charts'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'app', 'Chart.yaml'),
    'apiVersion: v2\nname: app\nversion: 1.0.0\n',
  );
  fs.writeFileSync(path.join(repo, 'dist', 'charts', 'app-1.0.0.tgz'), 'tgz');
  git(base, 'init', '--quiet', '--bare', remote);
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@example.test');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
  return { repo, remote };
}

/** Put a gh-pages branch with the given index.yaml content on the remote. */
function seedPages(repo: string, content: string): void {
  const original = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  git(repo, 'checkout', '--quiet', '--orphan', 'gh-pages');
  git(repo, 'rm', '-rf', '--quiet', '.');
  fs.writeFileSync(path.join(repo, 'index.yaml'), content);
  git(repo, 'add', 'index.yaml');
  git(repo, 'commit', '--quiet', '-m', 'pages');
  git(repo, 'push', '--quiet', 'origin', 'gh-pages');
  git(repo, 'checkout', '--quiet', '-f', original);
  git(repo, 'branch', '-D', '--quiet', 'gh-pages');
}

const settings = (repo: string, repositoryUrl?: string) => ({
  cwd: repo,
  chartPath: 'app',
  remote: 'origin',
  branch: 'gh-pages',
  repositoryUrl,
});

const author = { name: 'Bot', email: 'bot@example.test' };

describe('planGhPages and publishGhPages', () => {
  it(
    'refuses a malformed index before anything is published',
    withTempDir(async (base) => {
      const s = scenario(base);
      seedPages(s.repo, 'entries: []\n');
      const { logger } = recordingLogger();
      await expect(
        planGhPages(
          new GitClient({ logger, cwd: s.repo }),
          logger,
          settings(s.repo),
        ),
      ).rejects.toMatchObject({ code: 'EINVALIDINDEX' });
    }),
  );

  it(
    'refuses an invalid Chart.yaml before anything is published',
    withTempDir(async (base) => {
      const s = scenario(base);
      fs.writeFileSync(
        path.join(s.repo, 'app', 'Chart.yaml'),
        'a: 1\n---\nb: 2\n',
      );
      const { logger } = recordingLogger();
      await expect(
        planGhPages(
          new GitClient({ logger, cwd: s.repo }),
          logger,
          settings(s.repo),
        ),
      ).rejects.toMatchObject({ code: 'EINVALIDCHARTYAML' });
    }),
  );

  it(
    'publishes the index with release links from the repository URL and cleans up',
    withTempDir(async (base) => {
      const s = scenario(base);
      const { logger } = recordingLogger();
      const client = new GitClient({ logger, cwd: s.repo });
      const plan = await planGhPages(
        client,
        logger,
        settings(s.repo, 'https://github.com/o/r.git'),
      );
      await publishGhPages(client, logger, plan, {
        cwd: s.repo,
        files: ['dist/charts/app-1.0.0.tgz'],
        author,
      });
      const index = yaml.parse(git(s.remote, 'show', 'gh-pages:index.yaml'));
      expect(index.entries.app[0].urls).toEqual([
        'https://github.com/o/r/releases/download/v1.0.0/app-1.0.0.tgz',
      ]);
      expect(fs.existsSync(path.join(s.repo, '.gh-pages-tmp'))).toBe(false);
    }),
  );

  it(
    'uses the bare file name when no link base can be trusted',
    withTempDir(async (base) => {
      const s = scenario(base);
      const { logger } = recordingLogger();
      const client = new GitClient({ logger, cwd: s.repo });
      const plan = await planGhPages(client, logger, settings(s.repo));
      await publishGhPages(client, logger, plan, {
        cwd: s.repo,
        files: ['dist/charts/app-1.0.0.tgz'],
        author,
      });
      const index = yaml.parse(git(s.remote, 'show', 'gh-pages:index.yaml'));
      expect(index.entries.app[0].urls).toEqual(['app-1.0.0.tgz']);
    }),
  );

  it(
    'merges into an existing index and keeps earlier versions',
    withTempDir(async (base) => {
      const s = scenario(base);
      seedPages(
        s.repo,
        yaml.stringify({
          apiVersion: 'v1',
          entries: { app: [{ name: 'app', version: '0.9.0', urls: ['x'] }] },
        }),
      );
      const { logger } = recordingLogger();
      const client = new GitClient({ logger, cwd: s.repo });
      const plan = await planGhPages(client, logger, settings(s.repo));
      await publishGhPages(client, logger, plan, {
        cwd: s.repo,
        files: ['dist/charts/app-1.0.0.tgz'],
        author,
      });
      const index = yaml.parse(git(s.remote, 'show', 'gh-pages:index.yaml'));
      expect(
        index.entries.app.map((e: { version: string }) => e.version),
      ).toEqual(['1.0.0', '0.9.0']);
    }),
  );
});
