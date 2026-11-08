import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import type { PublishContext } from 'semantic-release';
import * as yaml from 'yaml';
// noinspection ES6PreferShortImport
import { publish } from '../src/index.js';
import { withTempDir } from './utils/tmpdir.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

/**
 * Run an async body with a different PATH and restore it afterwards.
 *
 * @param pathValue The PATH to use.
 * @param body The work to run.
 * @returns What the body returns.
 */
async function withPath<T>(
  pathValue: string,
  body: () => Promise<T>,
): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = pathValue;
  try {
    return await body();
  } finally {
    process.env.PATH = saved;
  }
}

const PASSWORD = 'pw "q" \'z\' $HOME `id`';

/**
 * A repository with a chart, one packaged chart, a bare remote named origin,
 * and a fake `docker` on PATH that records its argv and OCI_PASSWORD.
 */
function scenario(base: string): {
  repo: string;
  remote: string;
  dockerLog: string;
  path: string;
} {
  const repo = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  const bin = path.join(base, 'bin');
  const dockerLog = path.join(base, 'docker.log');
  fs.mkdirSync(path.join(repo, 'app'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'dist', 'charts'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(repo, 'app', 'Chart.yaml'),
    'apiVersion: v2\nname: app\nversion: 1.0.0\n',
  );
  fs.writeFileSync(path.join(repo, 'dist', 'charts', 'app-1.0.0.tgz'), 'tgz');
  fs.writeFileSync(
    path.join(bin, 'docker'),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${dockerLog}"\nprintf 'ENV:%s\\n' "$OCI_PASSWORD" >> "${dockerLog}"\n`,
    { mode: 0o755 },
  );
  git(base, 'init', '--quiet', '--bare', remote);
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@example.test');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
  return {
    repo,
    remote,
    dockerLog,
    path: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
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

const recordingLogger = () => {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      log: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
    },
  };
};

const contextOf = (
  cwd: string,
  logger: ReturnType<typeof recordingLogger>['logger'],
  repositoryUrl?: string,
): PublishContext =>
  // The step only reads cwd, logger and options.repositoryUrl.
  JSON.parse(JSON.stringify({ cwd, options: { repositoryUrl } }), (k, v) =>
    k === '' ? Object.assign(v, { logger }) : v,
  );

describe('publish (unit, fake docker on PATH, real git)', () => {
  it(
    'passes the OCI password only through the environment',
    withTempDir(async (base) => {
      const s = scenario(base);
      const { lines, logger } = recordingLogger();
      await withPath(s.path, () =>
        publish(
          {
            chartPath: 'app',
            ociRepo: 'oci://reg.example.test:5000/charts',
            ociUsername: 'user',
            ociPassword: PASSWORD,
            ghPages: { enabled: false },
          },
          contextOf(s.repo, logger),
        ),
      );
      const docker = fs.readFileSync(s.dockerLog, 'utf8');
      expect(docker).toContain('--env=OCI_PASSWORD');
      expect(docker).toContain(`ENV:${PASSWORD}`);
      expect(docker.replace(`ENV:${PASSWORD}`, '')).not.toContain('pw "q"');
      expect(lines.join('\n')).not.toContain('pw "q"');
      expect(docker).toContain('helm push');
    }),
  );

  it(
    'refuses a malformed index before the OCI push',
    withTempDir(async (base) => {
      const s = scenario(base);
      seedPages(s.repo, 'entries: []\n');
      const { logger } = recordingLogger();
      await expect(
        withPath(s.path, () =>
          publish(
            {
              chartPath: 'app',
              ociRepo: 'oci://reg.example.test:5000/charts',
              ghPages: { enabled: true },
            },
            contextOf(s.repo, logger),
          ),
        ),
      ).rejects.toMatchObject({ code: 'EINVALIDINDEX' });
      expect(fs.existsSync(s.dockerLog)).toBe(false);
    }),
  );

  it(
    'refuses an invalid Chart.yaml before the OCI push',
    withTempDir(async (base) => {
      const s = scenario(base);
      fs.writeFileSync(
        path.join(s.repo, 'app', 'Chart.yaml'),
        'a: 1\n---\nb: 2\n',
      );
      const { logger } = recordingLogger();
      await expect(
        withPath(s.path, () =>
          publish(
            {
              chartPath: 'app',
              ociRepo: 'oci://reg.example.test:5000/charts',
              ghPages: { enabled: true },
            },
            contextOf(s.repo, logger),
          ),
        ),
      ).rejects.toMatchObject({ code: 'EINVALIDCHARTYAML' });
      expect(fs.existsSync(s.dockerLog)).toBe(false);
    }),
  );

  it(
    'publishes the index to gh-pages with release links from the repository URL',
    withTempDir(async (base) => {
      const s = scenario(base);
      const { logger } = recordingLogger();
      await withPath(s.path, () =>
        publish(
          { chartPath: 'app' },
          contextOf(s.repo, logger, 'https://github.com/o/r.git'),
        ),
      );
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
      await withPath(s.path, () =>
        publish({ chartPath: 'app' }, contextOf(s.repo, logger)),
      );
      const index = yaml.parse(git(s.remote, 'show', 'gh-pages:index.yaml'));
      expect(index.entries.app[0].urls).toEqual(['app-1.0.0.tgz']);
    }),
  );

  it(
    'fails when there is no packaged chart',
    withTempDir(async (base) => {
      const s = scenario(base);
      fs.rmSync(path.join(s.repo, 'dist'), { recursive: true });
      const { logger } = recordingLogger();
      await expect(
        publish({ chartPath: 'app' }, contextOf(s.repo, logger)),
      ).rejects.toMatchObject({ code: 'ENOPACKAGEDCHART' });
    }),
  );
});
