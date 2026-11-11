import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from './utils/fs.js';
import { describe, expect, it } from '@jest/globals';
import yaml from 'yaml';
import { Chart } from '../src/chart.js';
import { ChartPackage } from '../src/chart-package.js';
import { DockerImage } from '../src/docker.js';
import {
  abandonGhPages,
  planGhPages,
  publishGhPages,
  verifyGhPages,
} from '../src/gh-pages.js';
import { git } from './utils/git.js';
import { fakeRunner, recordingLogger } from './utils/runner.js';
import { withTempDir } from './utils/tmpdir.js';

/**
 * A repository with a chart, one packaged chart, and a bare remote named
 * origin.
 */
async function scenario(
  base: string,
): Promise<{ repo: string; remote: string }> {
  const repo = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  await fs.mkdir(path.join(repo, 'app'), { recursive: true });
  await fs.mkdir(path.join(repo, 'dist', 'charts'), { recursive: true });
  await fs.writeFile(
    path.join(repo, 'app', 'Chart.yaml'),
    'apiVersion: v2\nname: app\nversion: 1.0.0\n',
  );
  await fs.writeFile(path.join(repo, 'dist', 'charts', 'app-1.0.0.tgz'), 'tgz');
  await git(base, 'init', '--quiet', '--bare', remote);
  await git(repo, 'init', '--quiet');
  await git(repo, 'config', 'user.name', 't');
  await git(repo, 'config', 'user.email', 't@example.test');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '--quiet', '-m', 'init');
  await git(repo, 'remote', 'add', 'origin', remote);
  return { repo, remote };
}

/** Put a gh-pages branch with the given index.yaml content on the remote. */
async function seedPages(repo: string, content: string): Promise<void> {
  const head = await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  const original = head.trim();
  await git(repo, 'checkout', '--quiet', '--orphan', 'gh-pages');
  await git(repo, 'rm', '-rf', '--quiet', '.');
  await fs.writeFile(path.join(repo, 'index.yaml'), content);
  await git(repo, 'add', 'index.yaml');
  await git(repo, 'commit', '--quiet', '-m', 'pages');
  await git(repo, 'push', '--quiet', 'origin', 'gh-pages');
  await git(repo, 'checkout', '--quiet', '-f', original);
  await git(repo, 'branch', '-D', '--quiet', 'gh-pages');
}

const author = { name: 'Bot', email: 'bot@example.test' };

/** No release tag, so release links use the package version. */
let noTag: string | undefined;

/** The context, and the chart, for a scenario's repository. */
async function setup(repo: string) {
  const { run } = fakeRunner();
  const { logger, lines } = recordingLogger();
  const image = new DockerImage({ image: 'unused', logger, cwd: repo, run });
  const context = { logger, cwd: repo };
  const chart = await Chart.open({
    directory: 'app',
    cwd: repo,
    logger,
    run,
    helm: image,
    docs: image,
  });
  return { context, chart, lines };
}

const settings = (chart: Chart, repositoryUrl?: string, url?: string) => ({
  chart,
  remote: 'origin',
  branch: 'gh-pages',
  url,
  repositoryUrl,
});

describe('verifyGhPages', () => {
  it(
    'returns the remote when it can be reached',
    withTempDir(async (base) => {
      const s = await scenario(base);
      const { context } = await setup(s.repo);
      const remote = await verifyGhPages(context, 'origin');
      expect(remote.name).toBe('origin');
    }),
  );

  it(
    'maps an unreachable remote to EREMOTEACCESS',
    withTempDir(async (base) => {
      const s = await scenario(base);
      await git(
        s.repo,
        'remote',
        'set-url',
        'origin',
        path.join(base, 'missing.git'),
      );
      const { context } = await setup(s.repo);
      await expect(verifyGhPages(context, 'origin')).rejects.toMatchObject({
        code: 'EREMOTEACCESS',
      });
    }),
  );

  it(
    'maps a missing remote to ENOREMOTE and a non-repository to ENOTGITREPO',
    withTempDir(async (base) => {
      const s = await scenario(base);
      const { context } = await setup(s.repo);
      await expect(verifyGhPages(context, 'nope')).rejects.toMatchObject({
        code: 'ENOREMOTE',
      });
      const { logger } = recordingLogger();
      await expect(
        verifyGhPages({ logger, cwd: base }, 'origin'),
      ).rejects.toMatchObject({ code: 'ENOTGITREPO' });
    }),
  );
});

describe('planGhPages and publishGhPages', () => {
  it(
    'refuses a malformed index before anything is published',
    withTempDir(async (base) => {
      const s = await scenario(base);
      await seedPages(s.repo, 'entries: []\n');
      const { context, chart } = await setup(s.repo);
      await expect(planGhPages(context, settings(chart))).rejects.toMatchObject(
        {
          code: 'EINVALIDINDEX',
        },
      );
    }),
  );

  it(
    'publishes the index with release links from the repository URL and cleans up',
    withTempDir(async (base) => {
      const s = await scenario(base);
      const { context, chart } = await setup(s.repo);
      const plan = await planGhPages(
        context,
        settings(chart, 'https://github.com/o/r.git'),
      );
      await publishGhPages(context, plan, {
        packages: await ChartPackage.find(path.join(s.repo, 'dist', 'charts')),
        author,
        tag: noTag,
      });
      const index = yaml.parse(
        await git(s.remote, 'show', 'gh-pages:index.yaml'),
      );
      expect(index.entries.app[0].urls).toEqual([
        'https://github.com/o/r/releases/download/v1.0.0/app-1.0.0.tgz',
      ]);
      expect(await pathExists(path.join(s.repo, '.gh-pages-tmp'))).toBe(false);
    }),
  );

  it(
    'uses the bare file name when no link base can be trusted',
    withTempDir(async (base) => {
      const s = await scenario(base);
      const { context, chart } = await setup(s.repo);
      const plan = await planGhPages(context, settings(chart));
      await publishGhPages(context, plan, {
        packages: await ChartPackage.find(path.join(s.repo, 'dist', 'charts')),
        author,
        tag: noTag,
      });
      const index = yaml.parse(
        await git(s.remote, 'show', 'gh-pages:index.yaml'),
      );
      expect(index.entries.app[0].urls).toEqual(['app-1.0.0.tgz']);
    }),
  );

  it(
    'merges into an existing index and keeps earlier versions',
    withTempDir(async (base) => {
      const s = await scenario(base);
      await seedPages(
        s.repo,
        yaml.stringify({
          apiVersion: 'v1',
          entries: { app: [{ name: 'app', version: '0.9.0', urls: ['x'] }] },
        }),
      );
      const { context, chart } = await setup(s.repo);
      const plan = await planGhPages(context, settings(chart));
      await publishGhPages(context, plan, {
        packages: await ChartPackage.find(path.join(s.repo, 'dist', 'charts')),
        author,
        tag: noTag,
      });
      const index = yaml.parse(
        await git(s.remote, 'show', 'gh-pages:index.yaml'),
      );
      expect(
        index.entries.app.map((e: { version: string }) => e.version),
      ).toEqual(['1.0.0', '0.9.0']);
    }),
  );

  it(
    'removes a leftover worktree from an earlier run',
    withTempDir(async (base) => {
      const s = await scenario(base);
      const { context, chart } = await setup(s.repo);
      await planGhPages(context, settings(chart));
      const second = await planGhPages(context, settings(chart));
      expect(second.worktree.directory).toBe(
        path.join(s.repo, '.gh-pages-tmp'),
      );
    }),
  );

  it(
    'uses the release tag it is given, not one derived from the file name',
    withTempDir(async (base) => {
      const s = await scenario(base);
      const { context, chart } = await setup(s.repo);
      const plan = await planGhPages(
        context,
        settings(chart, 'https://github.com/o/r.git'),
      );
      await publishGhPages(context, plan, {
        packages: await ChartPackage.find(path.join(s.repo, 'dist', 'charts')),
        author,
        tag: 'release-1.0.0',
      });
      const index = yaml.parse(
        await git(s.remote, 'show', 'gh-pages:index.yaml'),
      );
      expect(index.entries.app[0].urls).toEqual([
        'https://github.com/o/r/releases/download/release-1.0.0/app-1.0.0.tgz',
      ]);
    }),
  );

  it(
    'writes absolute links from ghPages.url when it is set',
    withTempDir(async (base) => {
      const s = await scenario(base);
      const { context, chart } = await setup(s.repo);
      const plan = await planGhPages(
        context,
        settings(
          chart,
          'https://github.com/o/r.git',
          'https://charts.example.test/',
        ),
      );
      await publishGhPages(context, plan, {
        packages: await ChartPackage.find(path.join(s.repo, 'dist', 'charts')),
        author,
        tag: noTag,
      });
      const index = yaml.parse(
        await git(s.remote, 'show', 'gh-pages:index.yaml'),
      );
      expect(index.entries.app[0].urls).toEqual([
        'https://charts.example.test/app-1.0.0.tgz',
      ]);
    }),
  );

  it(
    'warns when release links cannot be built',
    withTempDir(async (base) => {
      const s = await scenario(base);
      const { context, chart, lines } = await setup(s.repo);
      await planGhPages(context, settings(chart));
      expect(lines.some((l) => l.includes('cannot build release links'))).toBe(
        true,
      );
    }),
  );

  it(
    'removes the working tree when the index is refused',
    withTempDir(async (base) => {
      const s = await scenario(base);
      await seedPages(s.repo, 'entries: []\n');
      const { context, chart } = await setup(s.repo);
      await expect(planGhPages(context, settings(chart))).rejects.toThrow();
      expect(await pathExists(path.join(s.repo, '.gh-pages-tmp'))).toBe(false);
      expect(await git(s.repo, 'worktree', 'list')).not.toContain(
        '.gh-pages-tmp',
      );
    }),
  );

  it(
    'abandoning a plan removes the working tree',
    withTempDir(async (base) => {
      const s = await scenario(base);
      const { context, chart } = await setup(s.repo);
      const plan = await planGhPages(context, settings(chart));
      await abandonGhPages(plan);
      expect(await pathExists(path.join(s.repo, '.gh-pages-tmp'))).toBe(false);
      expect(await git(s.repo, 'worktree', 'list')).not.toContain(
        '.gh-pages-tmp',
      );
    }),
  );
});
