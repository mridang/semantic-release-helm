import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'node:child_process';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

// noinspection ES6PreferShortImport
import {
  verifyConditions,
  prepare,
  publish,
  type HelmPluginConfig,
} from '../src/index.js';
import type {
  VerifyConditionsContext,
  PrepareContext,
  PublishContext,
} from 'semantic-release';

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

describe('semantic-release-helm (integration, real Docker + local git)', () => {
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

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  let workdir: string;
  let chartPathInWorkdir: string;

  beforeAll(async () => {
    requireDocker();
    pull(HELM_IMAGE);
    pull(DOCS_IMAGE);

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
    const destChart = path.join(workdir, 'charts', 'app');

    if (!fs.existsSync(srcChart)) {
      const here = fs.readdirSync(__dirname).join(', ');
      throw new Error(`Missing test chart at ${srcChart}. dir: ${here}`);
    }

    fs.mkdirSync(path.dirname(destChart), { recursive: true });
    fs.cpSync(srcChart, destChart, { recursive: true });

    chartPathInWorkdir = 'charts/app';
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it('verifyConditions succeeds (GH Pages default)', async () => {
    const cfg: HelmPluginConfig = {
      chartPath: chartPathInWorkdir,
      helmImage: HELM_IMAGE,
      docsImage: DOCS_IMAGE,
      ociInsecure: true,
    };
    const ctx = { logger, cwd: workdir } as unknown as VerifyConditionsContext;

    await expect(verifyConditions(cfg, ctx)).resolves.toBeUndefined();
  }, 120_000);

  it('prepare creates packaged chart and index.yaml for GH Pages', async () => {
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
      path.join(workdir, 'charts', 'app', 'Chart.yaml'),
      'utf8',
    );
    expect(chartYaml).toMatch(/version:\s*0\.2\.0/);

    const dist = path.join(workdir, 'dist', 'charts');
    const files = fs.existsSync(dist) ? fs.readdirSync(dist) : [];
    expect(files.some((f) => f.endsWith('.tgz'))).toBe(true);
    expect(files.includes('index.yaml')).toBe(true);
  }, 180_000);

  it('publish pushes to local OCI (insecure, no credentials)', async () => {
    const prepCfg: HelmPluginConfig = {
      chartPath: chartPathInWorkdir,
      helmImage: HELM_IMAGE,
      docsImage: DOCS_IMAGE,
      ghPages: { enabled: true, url: 'https://example.test/charts' },
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
    };
    const pubCtx = { logger, cwd: workdir } as unknown as PublishContext;

    await expect(publish(pubCfg, pubCtx)).resolves.toBeUndefined();

    const dist = path.join(workdir, 'dist', 'charts');
    const files = fs.readdirSync(dist);
    expect(files.some((f) => f.endsWith('.tgz'))).toBe(true);
  }, 240_000);

  it('publish pushes to local OCI (insecure, with credentials)', async () => {
    const prepCfg: HelmPluginConfig = {
      chartPath: chartPathInWorkdir,
      helmImage: HELM_IMAGE,
      docsImage: DOCS_IMAGE,
      ghPages: { enabled: true },
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
    };
    const pubCtx = { logger, cwd: workdir } as unknown as PublishContext;

    await expect(publish(pubCfg, pubCtx)).resolves.toBeUndefined();

    const dist = path.join(workdir, 'dist', 'charts');
    const files = fs.readdirSync(dist);
    expect(files.some((f) => f.endsWith('.tgz'))).toBe(true);
  }, 240_000);

  it('publish fails when no packaged charts exist', async () => {
    const cfg: HelmPluginConfig = {
      chartPath: chartPathInWorkdir,
      helmImage: HELM_IMAGE,
      docsImage: DOCS_IMAGE,
      ociRepo: `oci://host.docker.internal:${registryPort}/charts`,
      ociInsecure: true,
    };
    const ctx = { logger, cwd: workdir } as unknown as PublishContext;

    fs.rmSync(path.join(workdir, 'dist'), { recursive: true, force: true });

    await expect(publish(cfg, ctx)).rejects.toHaveProperty(
      'code',
      'ENOPACKAGEDCHART',
    );
  }, 120_000);

  it('publish writes charts to a gh-pages branch in a local git repo (with a real origin remote)', async () => {
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
      ghPages: { enabled: true, branch: 'gh-pages', dir: 'charts' },
    };
    const pubCtx = { logger, cwd: workdir } as unknown as PublishContext;

    await expect(publish(pubCfg, pubCtx)).resolves.toBeUndefined();

    const branches = execSync('git branch --list', { cwd: workdir }).toString(
      'utf8',
    );
    expect(branches).toMatch(/gh-pages/);

    const lsRemote = execSync('git ls-remote --heads origin gh-pages', {
      cwd: workdir,
    }).toString('utf8');
    expect(lsRemote).toMatch(/refs\/heads\/gh-pages/);

    const checkDir = path.join(workdir, '.check-gh-pages');
    fs.mkdirSync(checkDir, { recursive: true });
    execSync(`git -C "${workdir}" worktree add "${checkDir}" gh-pages`);
    const chartsDir = path.join(checkDir, 'charts');
    expect(fs.existsSync(chartsDir)).toBe(true);
    const ghFiles = fs.readdirSync(chartsDir);
    expect(ghFiles.includes('index.yaml')).toBe(true);
    expect(ghFiles.some((f) => f.endsWith('.tgz'))).toBe(true);
  }, 240_000);
});
