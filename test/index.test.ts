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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import type { StartedTestContainer } from 'testcontainers';
import { parse, stringify } from 'yaml';

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
    // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
    execSync('docker version', { stdio: 'pipe' });
  } catch {
    throw new Error('Docker is required to run these tests.');
  }
}

function pull(image: string): void {
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
  execSync(`docker pull ${image}`, { stdio: 'pipe' });
}

/** Whether a Docker daemon answers; the integration suite needs one. */
const dockerAvailable = ((): boolean => {
  try {
    // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
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

    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- experimental API used on purpose
    const testDir = import.meta.dirname;

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
      workdir = path.join(testDir, `.it-${Date.now()}`);
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      fs.mkdirSync(workdir, { recursive: true });

      const srcChart = path.join(testDir, 'chart');
      const destChart = path.join(workdir, 'app');

      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      if (!fs.existsSync(srcChart)) {
        // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
        const here = fs.readdirSync(testDir).join(', ');
        throw new Error(`Missing test chart at ${srcChart}. dir: ${here}`);
      }

      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      fs.mkdirSync(path.dirname(destChart), { recursive: true });
      // eslint-disable-next-line n/no-sync, n/no-unsupported-features/node-builtins -- sync test helper, experimental API used on purpose
      fs.cpSync(srcChart, destChart, { recursive: true });

      chartPathInWorkdir = 'app';
    });

    afterEach(() => {
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
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

      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      const chartYaml = fs.readFileSync(
        path.join(workdir, 'app', 'Chart.yaml'),
        'utf8',
      );
      expect(chartYaml).toMatch(/version:\s*0\.2\.0/);

      const dist = path.join(workdir, 'dist', 'charts');
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
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
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
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
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      const files = fs.readdirSync(dist);
      expect(files.some((f) => f.endsWith('.tgz'))).toBe(true);
    }, 240_000);

    it('publish writes charts to gh-pages with a merged, correct index.yaml (fresh repo)', async () => {
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git init -b main', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git config user.email "ci@example.com"', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git config user.name "CI Tester"', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git add .', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git commit -m "init repo for gh-pages test"', { cwd: workdir });

      const remoteDir = path.join(workdir, '.remote.git');
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git init --bare "${remoteDir}"`);
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git remote add origin "${remoteDir}"`, { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
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

      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      const branches = execSync('git branch --list', {
        cwd: workdir,
      }).toString('utf8');
      expect(branches).toMatch(/gh-pages/);

      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      const lsRemote = execSync('git ls-remote --heads origin gh-pages', {
        cwd: workdir,
      }).toString('utf8');
      expect(lsRemote).toMatch(/refs\/heads\/gh-pages/);

      const checkDir = path.join(workdir, '.check-gh-pages');
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      fs.mkdirSync(checkDir, { recursive: true });
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git -C "${workdir}" worktree add "${checkDir}" gh-pages`);

      const chartsDir = path.join(checkDir);
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      expect(fs.existsSync(chartsDir)).toBe(true);

      const indexPath = path.join(chartsDir, 'index.yaml');
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      expect(fs.existsSync(indexPath)).toBe(true);

      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      const parsed = parse(fs.readFileSync(indexPath, 'utf8')) as {
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
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git init -b main', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git config user.email "ci@example.com"', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git config user.name "CI Tester"', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git add .', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git commit -m "init repo for gh-pages merge test"', {
        cwd: workdir,
      });

      const remoteDir = path.join(workdir, '.remote.git');
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git init --bare "${remoteDir}"`);
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git remote add origin "${remoteDir}"`, { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
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
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      fs.mkdirSync(checkDir, { recursive: true });
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git -C "${workdir}" worktree add "${checkDir}" gh-pages`);

      const indexPath = path.join(checkDir, 'index.yaml');
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      const parsed = parse(fs.readFileSync(indexPath, 'utf8')) as {
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
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git init -b main', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git config user.email "ci@example.com"', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git config user.name "CI Tester"', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git add .', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git commit -m "init repo for both publish test"', {
        cwd: workdir,
      });

      const remoteDir = path.join(workdir, '.remote.git');
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git init --bare "${remoteDir}"`);
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git remote add origin "${remoteDir}"`, { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
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
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      fs.mkdirSync(checkDir, { recursive: true });
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git -C "${workdir}" worktree add "${checkDir}" gh-pages`);
      const indexPath = path.join(checkDir, 'index.yaml');

      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      const parsed = parse(fs.readFileSync(indexPath, 'utf8')) as {
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
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git init -b main', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git config user.email "ci@example.com"', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git config user.name "CI Tester"', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git add .', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git commit -m "init repo for relative URL test"', {
        cwd: workdir,
      });

      const remoteDir = path.join(workdir, '.remote.git');
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git init --bare "${remoteDir}"`);
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git remote add origin "${remoteDir}"`, { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
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
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      fs.mkdirSync(checkDir, { recursive: true });
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git -C "${workdir}" worktree add "${checkDir}" gh-pages`);
      const indexPath = path.join(checkDir, 'index.yaml');

      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      const parsed = parse(fs.readFileSync(indexPath, 'utf8')) as {
        apiVersion: string;
        entries: Record<string, Array<{ urls: string[] }>>;
      };

      const urls = parsed.entries.app?.[0]?.urls ?? [];
      expect(urls.some((u) => u.endsWith('app-3.0.0.tgz'))).toBe(true);
    }, 240_000);

    it('publish preserves other chart names already present in index.yaml', async () => {
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git init -b main', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git config user.email "ci@example.com"', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git config user.name "CI Tester"', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git add .', { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git commit -m "init repo for preservation test"', {
        cwd: workdir,
      });

      const remoteDir = path.join(workdir, '.remote.git');
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git init --bare "${remoteDir}"`);
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git remote add origin "${remoteDir}"`, { cwd: workdir });
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      execSync('git push -u origin main', { cwd: workdir });

      const tmpWorktree = path.join(workdir, '.gh-pages-seed');
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git worktree add --detach "${tmpWorktree}"`, { cwd: workdir });
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git -C "${tmpWorktree}" switch --orphan gh-pages`);
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git -C "${tmpWorktree}" reset --hard`);

      const chartsDir = path.join(tmpWorktree);
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      fs.mkdirSync(chartsDir, { recursive: true });
      const seedIndex = stringify({
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
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      fs.writeFileSync(path.join(chartsDir, 'index.yaml'), seedIndex, 'utf8');
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git -C "${tmpWorktree}" add .`);
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(
        `git -C "${tmpWorktree}" commit -m "seed gh-pages with other chart"`,
      );
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git -C "${tmpWorktree}" push origin gh-pages`);
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
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
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      fs.mkdirSync(checkDir, { recursive: true });
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      execSync(`git -C "${workdir}" worktree add "${checkDir}" gh-pages`);
      const indexPath = path.join(checkDir, 'index.yaml');

      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      const parsed = parse(fs.readFileSync(indexPath, 'utf8')) as {
        apiVersion: string;
        entries: Record<string, Array<Record<string, unknown>>>;
      };

      expect(
        Object.keys(parsed.entries).toSorted((a, b) => a.localeCompare(b)),
      ).toEqual(['app', 'other']);
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
          // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
          execSync('git init -b main', { cwd: workdir });
          // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
          execSync('git config user.email "ci@example.com"', { cwd: workdir });
          // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
          execSync('git config user.name "CI Tester"', { cwd: workdir });
          // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
          execSync('git add .', { cwd: workdir });
          // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
          execSync('git commit -m "init matrix repo"', { cwd: workdir });

          const remoteDir = path.join(
            workdir,
            `.remote.${seed}.${urlMode}.git`,
          );
          // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
          execSync(`git init --bare "${remoteDir}"`);
          // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
          execSync(`git remote add origin "${remoteDir}"`, { cwd: workdir });
          // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
          execSync('git push -u origin main', { cwd: workdir });

          if (seed === 'remote') {
            const tmp = path.join(workdir, `.seed-${seed}-${urlMode}`);
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(`git worktree add --detach "${tmp}"`, { cwd: workdir });
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(`git -C "${tmp}" switch --orphan gh-pages`);
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(`git -C "${tmp}" reset --hard`);
            const chartsDir = path.join(tmp);
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            fs.mkdirSync(chartsDir, { recursive: true });
            const seeded = stringify({ apiVersion: 'v1', entries: {} });
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            fs.writeFileSync(
              path.join(chartsDir, 'index.yaml'),
              seeded,
              'utf8',
            );
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(`git -C "${tmp}" add .`);
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(`git -C "${tmp}" commit -m "seed remote gh-pages"`);
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(`git -C "${tmp}" push origin gh-pages`);
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(`git worktree remove "${tmp}" --force`, { cwd: workdir });
            // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
            execSync('git branch -D gh-pages || true', { cwd: workdir });
          } else if (seed === 'local') {
            const tmp = path.join(workdir, `.seed-${seed}-${urlMode}`);
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(`git worktree add --detach "${tmp}"`, { cwd: workdir });
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(`git -C "${tmp}" switch --orphan gh-pages`);
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(`git -C "${tmp}" reset --hard`);
            const chartsDir = path.join(tmp);
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            fs.mkdirSync(chartsDir, { recursive: true });
            const seeded = stringify({ apiVersion: 'v1', entries: {} });
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            fs.writeFileSync(
              path.join(chartsDir, 'index.yaml'),
              seeded,
              'utf8',
            );
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(`git -C "${tmp}" add .`);
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(`git -C "${tmp}" commit -m "seed local gh-pages"`);
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(`git -C "${tmp}" branch -M gh-pages`);
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            const head = execSync(`git -C "${tmp}" rev-parse gh-pages`)
              .toString('utf8')
              .trim();
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(`git update-ref refs/heads/gh-pages ${head}`, {
              cwd: workdir,
            });
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(`git worktree remove "${tmp}" --force`, { cwd: workdir });
            // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
            execSync(
              // eslint-disable-next-line sonarjs/no-os-command-from-path -- test shells out to git and docker from PATH on purpose
              'git show-ref --verify --quiet refs/remotes/origin/gh-pages || true',
              { cwd: workdir },
            );
          } else {
            // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
            execSync('git branch -D gh-pages || true', { cwd: workdir });
            // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
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

          // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
          const lsRemote = execSync('git ls-remote --heads origin gh-pages', {
            cwd: workdir,
          }).toString('utf8');
          expect(lsRemote).toMatch(/refs\/heads\/gh-pages/);

          const checkDir = path.join(
            workdir,
            `.check-matrix-${seed}-${urlMode}`,
          );
          // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
          fs.mkdirSync(checkDir, { recursive: true });
          // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
          execSync(`git -C "${workdir}" worktree add "${checkDir}" gh-pages`);
          const indexPath = path.join(checkDir, 'index.yaml');
          // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
          expect(fs.existsSync(indexPath)).toBe(true);

          // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
          const parsed = parse(fs.readFileSync(indexPath, 'utf8')) as {
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
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
  fs.mkdirSync(path.join(repo, 'app'), { recursive: true });
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
  fs.mkdirSync(path.join(repo, 'dist', 'charts'), { recursive: true });
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
  fs.mkdirSync(bin);
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
  fs.writeFileSync(
    path.join(repo, 'app', 'Chart.yaml'),
    'apiVersion: v2\nname: app\nversion: 1.0.0\n',
  );
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
  fs.writeFileSync(path.join(repo, 'dist', 'charts', 'app-1.0.0.tgz'), 'tgz');
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
  fs.writeFileSync(path.join(repo, 'dist', 'charts', 'app-0.9.0.tgz'), 'old');
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
  fs.writeFileSync(
    path.join(bin, 'docker'),
    `#!/bin/sh\nprintf 'CALL %s\\n' "$*" >> "${dockerLog}"\nprintf 'ENV:%s\\n' "$OCI_PASSWORD" >> "${dockerLog}"\ncase "$*" in *"$DOCKER_FAIL_ON"*) [ -n "$DOCKER_FAIL_ON" ] && exit 1;; esac\nexit 0\n`,
    { mode: 0o755 },
  );
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
  execSync(`git init --quiet --bare "${remote}"`);
  // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
  execSync('git init --quiet', { cwd: repo });
  // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
  execSync('git config user.name t && git config user.email t@example.test', {
    cwd: repo,
  });
  // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
  execSync('git add -A && git commit --quiet -m init', { cwd: repo });
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
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
    // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
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
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepare lints, renders, documents and packages in order, after setting the version', async () => {
    // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
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
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      const calls = fs
        .readFileSync(w.dockerLog, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('CALL '));
      expect(
        calls.map((c) => /(lint|template|helm-docs|package)/.exec(c)?.[1]),
      ).toEqual(['lint', 'template', 'helm-docs', 'package']);
      expect(
        // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
        fs.readFileSync(path.join(w.repo, 'app', 'Chart.yaml'), 'utf8'),
      ).toContain('version: 2.0.0');
    } finally {
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publish hands the OCI password over in the environment only', async () => {
    // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
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
            // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- test fixture value, not a credential
            ociPassword: 'hunter2value',
            ghPages: { enabled: false },
          },
          { cwd: w.repo, logger } as unknown as PublishContext,
        );
      });
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      const docker = fs.readFileSync(w.dockerLog, 'utf8');
      expect(docker).toContain('--env=OCI_PASSWORD');
      expect(docker).toContain('ENV:hunter2value');
      expect(docker.replaceAll('ENV:hunter2value', '')).not.toContain(
        'hunter2value',
      );
      expect(lines.join('\n')).not.toContain('hunter2value');
    } finally {
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publish checks the gh-pages index before the OCI push', async () => {
    // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-'));
    try {
      const w = wiring(dir);
      // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
      const original = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: w.repo,
        encoding: 'utf8',
      }).trim();
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
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
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      expect(fs.existsSync(w.dockerLog)).toBe(false);
    } finally {
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publish removes the working tree when the OCI push fails', async () => {
    // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
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
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      expect(fs.existsSync(path.join(w.repo, '.gh-pages-tmp'))).toBe(false);
      expect(
        // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
        execSync('git worktree list', { cwd: w.repo, encoding: 'utf8' }),
      ).not.toContain('.gh-pages-tmp');
    } finally {
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publish pushes only the chart's own package and uses the commit author from the environment", async () => {
    // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
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
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      const pushes = fs
        .readFileSync(w.dockerLog, 'utf8')
        .split('\n')
        .filter((l) => l.includes('helm push'));
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toContain('app-1.0.0.tgz');
      expect(
        // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
        execFileSync('git', ['log', '-1', '--format=%an|%ae', 'gh-pages'], {
          cwd: w.remote,
          encoding: 'utf8',
        }).trim(),
      ).toBe('Release Bot|bot@example.test');
      const index = parse(
        // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- test helper runs git and docker synchronously from PATH on purpose
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
      // eslint-disable-next-line n/no-sync -- sync is fine in a test helper, async would ripple through every test
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
