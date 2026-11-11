// file: test/index.integration.test.ts
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import type { StartedTestContainer } from 'testcontainers';
import * as yaml from 'yaml';

// noinspection ES6PreferShortImport
import { verifyConditions, prepare, publish } from '../src/index.js';
import type {
  VerifyConditionsContext,
  PrepareContext,
  PublishContext,
} from 'semantic-release';
import { HelmPluginConfig } from '../src/plugin-config.js';

const HELM_IMAGE = process.env.HELM_IMAGE ?? 'alpine/helm:3.15.2';
const DOCS_IMAGE = process.env.DOCS_IMAGE ?? 'jnorwood/helm-docs:v1.14.2';

function requireDocker(): void {
  try {
    execSync('docker version', { stdio: 'pipe' });
  } catch {
    throw new Error('Docker is required to run these tests.');
  }
}

function pull(image: string): void {
  execSync(`docker pull ${image}`, { stdio: 'pipe' });
}

/** Whether a Docker daemon answers; the integration suite needs one. */
const dockerAvailable = ((): boolean => {
  try {
    execSync('docker info', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

(dockerAvailable ? describe : describe.skip)(
  'semantic-release-helm (integration, real Docker + local git)',
  () => {
    let registry: StartedTestContainer | null = null;
    let registryPort = 0;

    const logger = {
      log: (...args: unknown[]) => {
        console.log(...args);
      },
      error: (...args: unknown[]) => {
        console.error(...args);
      },
    };

    const __filename = import.meta.filename;
    const __dirname = import.meta.dirname;

    let workdir: string;
    let chartPathInWorkdir: string;

    beforeAll(async () => {
      requireDocker();
      pull(HELM_IMAGE);
      pull(DOCS_IMAGE);

      const { GenericContainer, Wait } = await import('testcontainers');
      registry = await new GenericContainer('registry:2')
        .withExposedPorts(5000)
        .withWaitStrategy(Wait.forLogMessage(/listening on/))
        .start();

      registryPort = registry.getMappedPort(5000);
    }, 120_000);

    afterAll(async () => {
      if (registry !== null) {
        await registry.stop();
      }
    });

    beforeEach(() => {
      workdir = path.join(__dirname, `.it-${Date.now()}`);
      fs.mkdirSync(workdir, { recursive: true });

      const srcChart = path.join(__dirname, 'chart');
      const destChart = path.join(workdir, 'app');

      if (!fs.existsSync(srcChart)) {
        const here = fs.readdirSync(__dirname).join(', ');
        throw new Error(`Missing test chart at ${srcChart}. dir: ${here}`);
      }

      fs.mkdirSync(path.dirname(destChart), { recursive: true });
      fs.cpSync(srcChart, destChart, { recursive: true });

      chartPathInWorkdir = 'app';
    });

    afterEach(() => {
      fs.rmSync(workdir, { recursive: true, force: true });
    });

    it('verifyConditions succeeds (no OCI -> defaults to gh-pages path)', async () => {
      const cfg: HelmPluginConfig = {
        chartPath: chartPathInWorkdir,
        helmImage: HELM_IMAGE,
        docsImage: DOCS_IMAGE,
        ociInsecure: true,
      };
      const ctx = {
        logger,
        cwd: workdir,
      } as unknown as VerifyConditionsContext;

      await expect(verifyConditions(cfg, ctx)).resolves.toBeUndefined();
    }, 120_000);

    it('prepare packages chart (no index.yaml yet)', async () => {
      const cfg: HelmPluginConfig = {
        chartPath: chartPathInWorkdir,
        helmImage: HELM_IMAGE,
        docsImage: DOCS_IMAGE,
        ghPages: {
          enabled: true,
          url: 'https://example.test/charts',
        },
      };
      const ctx = {
        logger,
        cwd: workdir,
        nextRelease: { version: '0.2.0' },
      } as unknown as PrepareContext;

      await expect(prepare(cfg, ctx)).resolves.toBeUndefined();

      const chartYaml = fs.readFileSync(
        path.join(workdir, 'app', 'Chart.yaml'),
        'utf8',
      );
      expect(chartYaml).toMatch(/version:\s*0\.2\.0/);

      const dist = path.join(workdir, 'dist', 'charts');
      const files = fs.existsSync(dist) ? fs.readdirSync(dist) : [];

      expect(files.some((f) => f.endsWith('.tgz'))).toBe(true);
      expect(files.includes('index.yaml')).toBe(false);
    }, 180_000);

    it('publish pushes to local OCI only (insecure, no credentials, gh-pages disabled)', async () => {
      const prepCfg: HelmPluginConfig = {
        chartPath: chartPathInWorkdir,
        helmImage: HELM_IMAGE,
        docsImage: DOCS_IMAGE,
        ghPages: { enabled: false },
      };
      const prepCtx = {
        logger,
        cwd: workdir,
        nextRelease: { version: '0.3.0' },
      } as unknown as PrepareContext;

      await prepare(prepCfg, prepCtx);

      const ociRepo = `oci://host.docker.internal:${registryPort}/charts`;

      const pubCfg: HelmPluginConfig = {
        chartPath: chartPathInWorkdir,
        helmImage: HELM_IMAGE,
        docsImage: DOCS_IMAGE,
        ociRepo,
        ociInsecure: true,
        ghPages: { enabled: false },
      };
      const pubCtx = { logger, cwd: workdir } as unknown as PublishContext;

      await expect(publish(pubCfg, pubCtx)).resolves.toBeUndefined();

      const dist = path.join(workdir, 'dist', 'charts');
      const files = fs.readdirSync(dist);
      expect(files.some((f) => f.endsWith('.tgz'))).toBe(true);
    }, 240_000);

    it('publish pushes to local OCI only (insecure, with credentials, gh-pages disabled)', async () => {
      const prepCfg: HelmPluginConfig = {
        chartPath: chartPathInWorkdir,
        helmImage: HELM_IMAGE,
        docsImage: DOCS_IMAGE,
        ghPages: { enabled: false },
      };
      const prepCtx = {
        logger,
        cwd: workdir,
        nextRelease: { version: '0.4.0' },
      } as unknown as PrepareContext;

      await prepare(prepCfg, prepCtx);

      const ociRepo = `oci://host.docker.internal:${registryPort}/charts`;

      const pubCfg: HelmPluginConfig = {
        chartPath: chartPathInWorkdir,
        helmImage: HELM_IMAGE,
        docsImage: DOCS_IMAGE,
        ociRepo,
        ociInsecure: true,
        ociUsername: 'anonymous',
        ociPassword: 'anonymous',
        ghPages: { enabled: false },
      };
      const pubCtx = { logger, cwd: workdir } as unknown as PublishContext;

      await expect(publish(pubCfg, pubCtx)).resolves.toBeUndefined();

      const dist = path.join(workdir, 'dist', 'charts');
      const files = fs.readdirSync(dist);
      expect(files.some((f) => f.endsWith('.tgz'))).toBe(true);
    }, 240_000);

    it('publish writes charts to gh-pages with a merged, correct index.yaml (fresh repo)', async () => {
      execSync('git init -b main', { cwd: workdir });
      execSync('git config user.email "ci@example.com"', { cwd: workdir });
      execSync('git config user.name "CI Tester"', { cwd: workdir });
      execSync('git add .', { cwd: workdir });
      execSync('git commit -m "init repo for gh-pages test"', { cwd: workdir });

      const remoteDir = path.join(workdir, '.remote.git');
      execSync(`git init --bare "${remoteDir}"`);
      execSync(`git remote add origin "${remoteDir}"`, { cwd: workdir });
      execSync('git push -u origin main', { cwd: workdir });

      const prepCfg: HelmPluginConfig = {
        chartPath: chartPathInWorkdir,
        helmImage: HELM_IMAGE,
        docsImage: DOCS_IMAGE,
        ghPages: { enabled: true, url: 'https://example.test/charts' },
      };
      const prepCtx = {
        logger,
        cwd: workdir,
        nextRelease: { version: '0.5.0' },
      } as unknown as PrepareContext;
      await prepare(prepCfg, prepCtx);

      const pubCfg: HelmPluginConfig = {
        chartPath: chartPathInWorkdir,
        helmImage: HELM_IMAGE,
        docsImage: DOCS_IMAGE,
        ghPages: {
          enabled: true,
          branch: 'gh-pages',
          url: 'https://example.test/charts',
        },
      };
      const pubCtx = { logger, cwd: workdir } as unknown as PublishContext;

      await expect(publish(pubCfg, pubCtx)).resolves.toBeUndefined();

      const branches = execSync('git branch --list', {
        cwd: workdir,
      }).toString('utf8');
      expect(branches).toMatch(/gh-pages/);

      const lsRemote = execSync('git ls-remote --heads origin gh-pages', {
        cwd: workdir,
      }).toString('utf8');
      expect(lsRemote).toMatch(/refs\/heads\/gh-pages/);

      const checkDir = path.join(workdir, '.check-gh-pages');
      fs.mkdirSync(checkDir, { recursive: true });
      execSync(`git -C "${workdir}" worktree add "${checkDir}" gh-pages`);

      const chartsDir = path.join(checkDir);
      expect(fs.existsSync(chartsDir)).toBe(true);

      const indexPath = path.join(chartsDir, 'index.yaml');
      expect(fs.existsSync(indexPath)).toBe(true);

      const parsed = yaml.parse(fs.readFileSync(indexPath, 'utf8')) as {
        apiVersion: string;
        entries: Record<string, Array<Record<string, unknown>>>;
      };

      const appEntries = parsed.entries.app ?? [];
      expect(appEntries.length).toBeGreaterThan(0);
      const firstEntry = appEntries[0] as {
        urls: string[];
        apiVersion: string;
        name: string;
        version: string;
      };
      expect(firstEntry.urls).toBeDefined();
      expect(firstEntry.urls.length).toBeGreaterThan(0);
      expect(firstEntry.urls[0]).toMatch(/app-0\.5\.0\.tgz$/);
      expect(firstEntry).toMatchObject({
        apiVersion: 'v2',
        name: 'app',
        version: '0.5.0',
      });
    }, 240_000);

    it('publish merges index.yaml across releases (sorted desc by version)', async () => {
      execSync('git init -b main', { cwd: workdir });
      execSync('git config user.email "ci@example.com"', { cwd: workdir });
      execSync('git config user.name "CI Tester"', { cwd: workdir });
      execSync('git add .', { cwd: workdir });
      execSync('git commit -m "init repo for gh-pages merge test"', {
        cwd: workdir,
      });

      const remoteDir = path.join(workdir, '.remote.git');
      execSync(`git init --bare "${remoteDir}"`);
      execSync(`git remote add origin "${remoteDir}"`, { cwd: workdir });
      execSync('git push -u origin main', { cwd: workdir });

      const baseCfg: Pick<
        HelmPluginConfig,
        'chartPath' | 'helmImage' | 'docsImage'
      > = {
        chartPath: chartPathInWorkdir,
        helmImage: HELM_IMAGE,
        docsImage: DOCS_IMAGE,
      };

      await prepare({ ...baseCfg, ghPages: { enabled: true } }, {
        logger,
        cwd: workdir,
        nextRelease: { version: '1.0.0' },
      } as unknown as PrepareContext);
      await publish(
        {
          ...baseCfg,
          ghPages: { enabled: true, branch: 'gh-pages' },
        },
        { logger, cwd: workdir } as unknown as PublishContext,
      );

      await prepare({ ...baseCfg, ghPages: { enabled: true } }, {
        logger,
        cwd: workdir,
        nextRelease: { version: '1.1.0' },
      } as unknown as PrepareContext);
      await publish(
        {
          ...baseCfg,
          ghPages: { enabled: true, branch: 'gh-pages' },
        },
        { logger, cwd: workdir } as unknown as PublishContext,
      );

      const checkDir = path.join(workdir, '.check-gh-pages-merge');
      fs.mkdirSync(checkDir, { recursive: true });
      execSync(`git -C "${workdir}" worktree add "${checkDir}" gh-pages`);

      const indexPath = path.join(checkDir, 'index.yaml');
      const parsed = yaml.parse(fs.readFileSync(indexPath, 'utf8')) as {
        apiVersion: string;
        entries: Record<string, Array<{ version: string }>>;
      };

      expect(parsed).toEqual(
        expect.objectContaining({
          apiVersion: 'v1',
          entries: {
            app: expect.arrayContaining([
              expect.objectContaining({ version: '1.1.0' }),
              expect.objectContaining({ version: '1.0.0' }),
            ]),
          },
        }),
      );

      const versions = (parsed.entries.app ?? []).map((e) => e.version);
      expect(versions.indexOf('1.1.0')).toBeLessThan(versions.indexOf('1.0.0'));
    }, 300_000);

    it('publish (both) pushes to OCI and also updates gh-pages with base URL', async () => {
      execSync('git init -b main', { cwd: workdir });
      execSync('git config user.email "ci@example.com"', { cwd: workdir });
      execSync('git config user.name "CI Tester"', { cwd: workdir });
      execSync('git add .', { cwd: workdir });
      execSync('git commit -m "init repo for both publish test"', {
        cwd: workdir,
      });

      const remoteDir = path.join(workdir, '.remote.git');
      execSync(`git init --bare "${remoteDir}"`);
      execSync(`git remote add origin "${remoteDir}"`, { cwd: workdir });
      execSync('git push -u origin main', { cwd: workdir });

      await prepare(
        {
          chartPath: chartPathInWorkdir,
          helmImage: HELM_IMAGE,
          docsImage: DOCS_IMAGE,
          ghPages: { enabled: true, url: 'https://example.test/charts' },
        },
        {
          logger,
          cwd: workdir,
          nextRelease: { version: '2.0.0' },
        } as unknown as PrepareContext,
      );

      const ociRepo = `oci://host.docker.internal:${registryPort}/charts`;

      await expect(
        publish(
          {
            chartPath: chartPathInWorkdir,
            helmImage: HELM_IMAGE,
            docsImage: DOCS_IMAGE,
            ociRepo,
            ociInsecure: true,
            ghPages: {
              enabled: true,
              branch: 'gh-pages',
              url: 'https://example.test/charts',
            },
          },
          { logger, cwd: workdir } as unknown as PublishContext,
        ),
      ).resolves.toBeUndefined();

      const checkDir = path.join(workdir, '.check-both');
      fs.mkdirSync(checkDir, { recursive: true });
      execSync(`git -C "${workdir}" worktree add "${checkDir}" gh-pages`);
      const indexPath = path.join(checkDir, 'index.yaml');

      const parsed = yaml.parse(fs.readFileSync(indexPath, 'utf8')) as {
        apiVersion: string;
        entries: Record<string, Array<Record<string, unknown>>>;
      };

      const appEntries = parsed.entries.app ?? [];
      expect(appEntries.length).toBeGreaterThan(0);
      const firstEntry = appEntries[0] as { urls: string[]; version: string };
      expect(firstEntry.urls).toBeDefined();
      expect(firstEntry.urls.length).toBeGreaterThan(0);
      expect(firstEntry.urls[0]).toMatch(/app-2\.0\.0\.tgz$/);
      expect(firstEntry).toMatchObject({
        version: '2.0.0',
      });
    }, 300_000);

    it('publish writes relative URLs when ghPages.url is omitted', async () => {
      execSync('git init -b main', { cwd: workdir });
      execSync('git config user.email "ci@example.com"', { cwd: workdir });
      execSync('git config user.name "CI Tester"', { cwd: workdir });
      execSync('git add .', { cwd: workdir });
      execSync('git commit -m "init repo for relative URL test"', {
        cwd: workdir,
      });

      const remoteDir = path.join(workdir, '.remote.git');
      execSync(`git init --bare "${remoteDir}"`);
      execSync(`git remote add origin "${remoteDir}"`, { cwd: workdir });
      execSync('git push -u origin main', { cwd: workdir });

      await prepare(
        {
          chartPath: chartPathInWorkdir,
          helmImage: HELM_IMAGE,
          docsImage: DOCS_IMAGE,
          ghPages: { enabled: true },
        },
        {
          logger,
          cwd: workdir,
          nextRelease: { version: '3.0.0' },
        } as unknown as PrepareContext,
      );

      await publish(
        {
          chartPath: chartPathInWorkdir,
          helmImage: HELM_IMAGE,
          docsImage: DOCS_IMAGE,
          ghPages: { enabled: true, branch: 'gh-pages' },
        },
        { logger, cwd: workdir } as unknown as PublishContext,
      );

      const checkDir = path.join(workdir, '.check-relative');
      fs.mkdirSync(checkDir, { recursive: true });
      execSync(`git -C "${workdir}" worktree add "${checkDir}" gh-pages`);
      const indexPath = path.join(checkDir, 'index.yaml');

      const parsed = yaml.parse(fs.readFileSync(indexPath, 'utf8')) as {
        apiVersion: string;
        entries: Record<string, Array<{ urls: string[] }>>;
      };

      const urls = parsed.entries.app?.[0]?.urls ?? [];
      expect(urls.some((u) => u.endsWith('app-3.0.0.tgz'))).toBe(true);
    }, 240_000);

    it('publish preserves other chart names already present in index.yaml', async () => {
      execSync('git init -b main', { cwd: workdir });
      execSync('git config user.email "ci@example.com"', { cwd: workdir });
      execSync('git config user.name "CI Tester"', { cwd: workdir });
      execSync('git add .', { cwd: workdir });
      execSync('git commit -m "init repo for preservation test"', {
        cwd: workdir,
      });

      const remoteDir = path.join(workdir, '.remote.git');
      execSync(`git init --bare "${remoteDir}"`);
      execSync(`git remote add origin "${remoteDir}"`, { cwd: workdir });
      execSync('git push -u origin main', { cwd: workdir });

      const tmpWorktree = path.join(workdir, '.gh-pages-seed');
      execSync(`git worktree add --detach "${tmpWorktree}"`, { cwd: workdir });
      execSync(`git -C "${tmpWorktree}" switch --orphan gh-pages`);
      execSync(`git -C "${tmpWorktree}" reset --hard`);

      const chartsDir = path.join(tmpWorktree);
      fs.mkdirSync(chartsDir, { recursive: true });
      const seedIndex = yaml.stringify({
        apiVersion: 'v1',
        entries: {
          other: [
            {
              apiVersion: 'v2',
              name: 'other',
              version: '9.9.9',
              created: new Date().toISOString(),
              digest: 'deadbeef',
              urls: ['other-9.9.9.tgz'],
            },
          ],
        },
      });
      fs.writeFileSync(path.join(chartsDir, 'index.yaml'), seedIndex, 'utf8');
      execSync(`git -C "${tmpWorktree}" add .`);
      execSync(
        `git -C "${tmpWorktree}" commit -m "seed gh-pages with other chart"`,
      );
      execSync(`git -C "${tmpWorktree}" push origin gh-pages`);
      execSync(`git worktree remove "${tmpWorktree}" --force`, {
        cwd: workdir,
      });

      await prepare(
        {
          chartPath: chartPathInWorkdir,
          helmImage: HELM_IMAGE,
          docsImage: DOCS_IMAGE,
          ghPages: { enabled: true },
        },
        {
          logger,
          cwd: workdir,
          nextRelease: { version: '4.0.0' },
        } as unknown as PrepareContext,
      );
      await publish(
        {
          chartPath: chartPathInWorkdir,
          helmImage: HELM_IMAGE,
          docsImage: DOCS_IMAGE,
          ghPages: { enabled: true, branch: 'gh-pages' },
        },
        { logger, cwd: workdir } as unknown as PublishContext,
      );

      const checkDir = path.join(workdir, '.check-preserve');
      fs.mkdirSync(checkDir, { recursive: true });
      execSync(`git -C "${workdir}" worktree add "${checkDir}" gh-pages`);
      const indexPath = path.join(checkDir, 'index.yaml');

      const parsed = yaml.parse(fs.readFileSync(indexPath, 'utf8')) as {
        apiVersion: string;
        entries: Record<string, Array<Record<string, unknown>>>;
      };

      expect(Object.keys(parsed.entries).sort()).toEqual(['app', 'other']);
      expect(parsed.entries.other).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'other', version: '9.9.9' }),
        ]),
      );
      expect(parsed.entries.app).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'app', version: '4.0.0' }),
        ]),
      );
    }, 300_000);

    describe.each([
      { seed: 'remote', urlMode: 'absolute' },
      { seed: 'remote', urlMode: 'relative' },
      { seed: 'local', urlMode: 'absolute' },
      { seed: 'local', urlMode: 'relative' },
      { seed: 'none', urlMode: 'absolute' },
      { seed: 'none', urlMode: 'relative' },
    ] as const)(
      'gh-pages worktree matrix: seed=%s urlMode=%s',
      ({ seed, urlMode }) => {
        it(`publishes and validates index.yaml for seed=${seed}, urlMode=${urlMode}`, async () => {
          execSync('git init -b main', { cwd: workdir });
          execSync('git config user.email "ci@example.com"', { cwd: workdir });
          execSync('git config user.name "CI Tester"', { cwd: workdir });
          execSync('git add .', { cwd: workdir });
          execSync('git commit -m "init matrix repo"', { cwd: workdir });

          const remoteDir = path.join(
            workdir,
            `.remote.${seed}.${urlMode}.git`,
          );
          execSync(`git init --bare "${remoteDir}"`);
          execSync(`git remote add origin "${remoteDir}"`, { cwd: workdir });
          execSync('git push -u origin main', { cwd: workdir });

          if (seed === 'remote') {
            const tmp = path.join(workdir, `.seed-${seed}-${urlMode}`);
            execSync(`git worktree add --detach "${tmp}"`, { cwd: workdir });
            execSync(`git -C "${tmp}" switch --orphan gh-pages`);
            execSync(`git -C "${tmp}" reset --hard`);
            const chartsDir = path.join(tmp);
            fs.mkdirSync(chartsDir, { recursive: true });
            const seeded = yaml.stringify({ apiVersion: 'v1', entries: {} });
            fs.writeFileSync(
              path.join(chartsDir, 'index.yaml'),
              seeded,
              'utf8',
            );
            execSync(`git -C "${tmp}" add .`);
            execSync(`git -C "${tmp}" commit -m "seed remote gh-pages"`);
            execSync(`git -C "${tmp}" push origin gh-pages`);
            execSync(`git worktree remove "${tmp}" --force`, { cwd: workdir });
            execSync('git branch -D gh-pages || true', { cwd: workdir });
          } else if (seed === 'local') {
            const tmp = path.join(workdir, `.seed-${seed}-${urlMode}`);
            execSync(`git worktree add --detach "${tmp}"`, { cwd: workdir });
            execSync(`git -C "${tmp}" switch --orphan gh-pages`);
            execSync(`git -C "${tmp}" reset --hard`);
            const chartsDir = path.join(tmp);
            fs.mkdirSync(chartsDir, { recursive: true });
            const seeded = yaml.stringify({ apiVersion: 'v1', entries: {} });
            fs.writeFileSync(
              path.join(chartsDir, 'index.yaml'),
              seeded,
              'utf8',
            );
            execSync(`git -C "${tmp}" add .`);
            execSync(`git -C "${tmp}" commit -m "seed local gh-pages"`);
            execSync(`git -C "${tmp}" branch -M gh-pages`);
            const head = execSync(`git -C "${tmp}" rev-parse gh-pages`)
              .toString('utf8')
              .trim();
            execSync(`git update-ref refs/heads/gh-pages ${head}`, {
              cwd: workdir,
            });
            execSync(`git worktree remove "${tmp}" --force`, { cwd: workdir });
            execSync(
              'git show-ref --verify --quiet refs/remotes/origin/gh-pages || true',
              { cwd: workdir },
            );
          } else {
            execSync('git branch -D gh-pages || true', { cwd: workdir });
            execSync('git push origin :gh-pages || true', { cwd: workdir });
          }

          await prepare(
            {
              chartPath: chartPathInWorkdir,
              helmImage: HELM_IMAGE,
              docsImage: DOCS_IMAGE,
              ghPages: {
                enabled: true,
                url:
                  urlMode === 'absolute'
                    ? 'https://example.test/charts'
                    : undefined,
              },
            },
            {
              logger,
              cwd: workdir,
              nextRelease: { version: '9.0.0' },
            } as unknown as PrepareContext,
          );

          await expect(
            publish(
              {
                chartPath: chartPathInWorkdir,
                helmImage: HELM_IMAGE,
                docsImage: DOCS_IMAGE,
                ghPages: {
                  enabled: true,
                  branch: 'gh-pages',
                  url:
                    urlMode === 'absolute'
                      ? 'https://example.test/charts'
                      : undefined,
                },
              },
              { logger, cwd: workdir } as unknown as PublishContext,
            ),
          ).resolves.toBeUndefined();

          const lsRemote = execSync('git ls-remote --heads origin gh-pages', {
            cwd: workdir,
          }).toString('utf8');
          expect(lsRemote).toMatch(/refs\/heads\/gh-pages/);

          const checkDir = path.join(
            workdir,
            `.check-matrix-${seed}-${urlMode}`,
          );
          fs.mkdirSync(checkDir, { recursive: true });
          execSync(`git -C "${workdir}" worktree add "${checkDir}" gh-pages`);
          const indexPath = path.join(checkDir, 'index.yaml');
          expect(fs.existsSync(indexPath)).toBe(true);

          const parsed = yaml.parse(fs.readFileSync(indexPath, 'utf8')) as {
            apiVersion: string;
            entries: Record<string, Array<{ version: string; urls: string[] }>>;
          };

          expect(parsed.apiVersion).toBe('v1');
          expect(parsed.entries.app).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ version: '9.0.0' }),
            ]),
          );

          const entry = parsed.entries.app.find(
            (e) => e.version === '9.0.0',
          ) as {
            urls: string[];
          };
          expect(Array.isArray(entry.urls) && entry.urls.length > 0).toBe(true);
          expect(entry.urls[0]).toMatch(/app-9\.0\.0\.tgz$/);
        }, 360_000);
      },
    );
  },
);

/**
 * A repository with a chart, two packaged charts (one stale), and a bare
 * remote named origin; and a fake `docker` first on PATH that records each
 * call, the OCI password it received, and fails when asked to.
 */
function wiring(base: string): {
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
  fs.writeFileSync(path.join(repo, 'dist', 'charts', 'app-0.9.0.tgz'), 'old');
  fs.writeFileSync(
    path.join(bin, 'docker'),
    `#!/bin/sh\nprintf 'CALL %s\\n' "$*" >> "${dockerLog}"\nprintf 'ENV:%s\\n' "$OCI_PASSWORD" >> "${dockerLog}"\ncase "$*" in *"$DOCKER_FAIL_ON"*) [ -n "$DOCKER_FAIL_ON" ] && exit 1;; esac\nexit 0\n`,
    { mode: 0o755 },
  );
  execSync(`git init --quiet --bare "${remote}"`);
  execSync('git init --quiet', { cwd: repo });
  execSync('git config user.name t && git config user.email t@example.test', {
    cwd: repo,
  });
  execSync('git add -A && git commit --quiet -m init', { cwd: repo });
  execSync(`git remote add origin "${remote}"`, { cwd: repo });
  return {
    repo,
    remote,
    dockerLog,
    path: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
}

/** Run a body with a different PATH and extra variables, then restore them. */
async function withWiringEnv<T>(
  vars: Record<string, string>,
  body: () => Promise<T>,
): Promise<T> {
  const saved = Object.fromEntries(
    Object.keys(vars).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, vars);
  try {
    return await body();
  } finally {
    Object.entries(saved).forEach(([k, v]) => {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    });
  }
}

const recording = () => {
  const lines: string[] = [];
  const write = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  return { lines, logger: { log: write, error: write, warn: write } };
};

describe('semantic-release-helm wiring (fake docker on PATH, real git)', () => {
  const OCI = 'oci://reg.example.test:5000/charts';

  it('verifyConditions refuses incomplete OCI credentials', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-'));
    try {
      const w = wiring(dir);
      const { logger } = recording();
      await withWiringEnv({ PATH: w.path }, async () => {
        await expect(
          verifyConditions(
            {
              chartPath: 'app',
              ociRepo: OCI,
              ociUsername: 'user',
              ghPages: { enabled: false },
            },
            { cwd: w.repo, logger } as unknown as VerifyConditionsContext,
          ),
        ).rejects.toMatchObject({ code: 'EOCICREDSINCOMPLETE' });
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepare lints, renders, documents and packages in order, after setting the version', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-'));
    try {
      const w = wiring(dir);
      const { logger } = recording();
      await withWiringEnv({ PATH: w.path }, async () => {
        await prepare({ chartPath: 'app', ghPages: { enabled: false } }, {
          cwd: w.repo,
          logger,
          nextRelease: { version: '2.0.0' },
        } as unknown as PrepareContext);
      });
      const calls = fs
        .readFileSync(w.dockerLog, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('CALL '));
      expect(
        calls.map((c) => /(lint|template|helm-docs|package)/.exec(c)?.[1]),
      ).toEqual(['lint', 'template', 'helm-docs', 'package']);
      expect(
        fs.readFileSync(path.join(w.repo, 'app', 'Chart.yaml'), 'utf8'),
      ).toContain('version: 2.0.0');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publish hands the OCI password over in the environment only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-'));
    try {
      const w = wiring(dir);
      const { logger, lines } = recording();
      await withWiringEnv({ PATH: w.path }, async () => {
        await publish(
          {
            chartPath: 'app',
            ociRepo: OCI,
            ociUsername: 'user',
            ociPassword: 'hunter2value',
            ghPages: { enabled: false },
          },
          { cwd: w.repo, logger } as unknown as PublishContext,
        );
      });
      const docker = fs.readFileSync(w.dockerLog, 'utf8');
      expect(docker).toContain('--env=OCI_PASSWORD');
      expect(docker).toContain('ENV:hunter2value');
      expect(docker.replaceAll('ENV:hunter2value', '')).not.toContain(
        'hunter2value',
      );
      expect(lines.join('\n')).not.toContain('hunter2value');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publish checks the gh-pages index before the OCI push', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-'));
    try {
      const w = wiring(dir);
      const original = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: w.repo,
        encoding: 'utf8',
      }).trim();
      execSync(
        String.raw`git checkout --quiet --orphan gh-pages && git rm -rf --quiet . && printf 'entries: []\n' > index.yaml && git add index.yaml && git commit --quiet -m pages && git push --quiet origin gh-pages && git checkout --quiet -f ${original} && git branch -D --quiet gh-pages`,
        { cwd: w.repo },
      );
      const { logger } = recording();
      await withWiringEnv({ PATH: w.path }, async () => {
        await expect(
          publish({ chartPath: 'app', ociRepo: OCI }, {
            cwd: w.repo,
            logger,
          } as unknown as PublishContext),
        ).rejects.toMatchObject({ code: 'EINVALIDINDEX' });
      });
      expect(fs.existsSync(w.dockerLog)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publish removes the working tree when the OCI push fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-'));
    try {
      const w = wiring(dir);
      const { logger } = recording();
      await withWiringEnv(
        { PATH: w.path, DOCKER_FAIL_ON: 'helm push' },
        async () => {
          await expect(
            publish({ chartPath: 'app', ociRepo: OCI }, {
              cwd: w.repo,
              logger,
            } as unknown as PublishContext),
          ).rejects.toThrow();
        },
      );
      expect(fs.existsSync(path.join(w.repo, '.gh-pages-tmp'))).toBe(false);
      expect(
        execSync('git worktree list', { cwd: w.repo, encoding: 'utf8' }),
      ).not.toContain('.gh-pages-tmp');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publish pushes only the chart's own package and uses the commit author from the environment", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-'));
    try {
      const w = wiring(dir);
      const { logger } = recording();
      await withWiringEnv(
        {
          PATH: w.path,
          GIT_AUTHOR_NAME: 'Release Bot',
          GIT_AUTHOR_EMAIL: 'bot@example.test',
        },
        async () => {
          await publish({ chartPath: 'app', ociRepo: OCI }, {
            cwd: w.repo,
            logger,
            nextRelease: { gitTag: 'v1.0.0' },
            options: { repositoryUrl: 'https://github.com/o/r.git' },
          } as unknown as PublishContext);
        },
      );
      const pushes = fs
        .readFileSync(w.dockerLog, 'utf8')
        .split('\n')
        .filter((l) => l.includes('helm push'));
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toContain('app-1.0.0.tgz');
      expect(
        execFileSync('git', ['log', '-1', '--format=%an|%ae', 'gh-pages'], {
          cwd: w.remote,
          encoding: 'utf8',
        }).trim(),
      ).toBe('Release Bot|bot@example.test');
      const index = yaml.parse(
        execSync('git show gh-pages:index.yaml', {
          cwd: w.remote,
          encoding: 'utf8',
        }),
      );
      expect(index.entries.app).toHaveLength(1);
      expect(index.entries.app[0].urls).toEqual([
        'https://github.com/o/r/releases/download/v1.0.0/app-1.0.0.tgz',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
