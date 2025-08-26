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

describe('semantic-release-helm (integration, real Docker)', () => {
  let registry: StartedTestContainer | null = null;
  let registryPort: number = 0;

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

  it('verifyConditions succeeds with real chart and images', async () => {
    const cfg: HelmPluginConfig = {
      chartPath: chartPathInWorkdir,
      helmImage: HELM_IMAGE,
      docsImage: DOCS_IMAGE,
      docsArgs: ['--sort-values'],
    };
    const ctx = { logger, cwd: workdir } as unknown as VerifyConditionsContext;

    await expect(verifyConditions(cfg, ctx)).resolves.toBeUndefined();
  }, 120_000);

  it('prepare bumps version, lints, templates, docs, and packages', async () => {
    const cfg: HelmPluginConfig = {
      chartPath: chartPathInWorkdir,
      helmImage: HELM_IMAGE,
      docsImage: DOCS_IMAGE,
      docsArgs: ['--sort-values'],
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

    const readme = path.join(workdir, 'charts', 'app', 'README.md');
    expect(fs.existsSync(readme)).toBe(true);
  }, 180_000);

  it('publish pushes to a real OCI registry (registry:2)', async () => {
    const prepCfg: HelmPluginConfig = {
      chartPath: chartPathInWorkdir,
      helmImage: HELM_IMAGE,
      docsImage: DOCS_IMAGE,
    };
    const prepCtx = {
      logger,
      cwd: workdir,
      nextRelease: { version: '0.3.0' },
    } as unknown as PrepareContext;

    await prepare(prepCfg, prepCtx);

    // IMPORTANT:
    // use host.docker.internal so the Helm container can reach the host-
    // bound Testcontainers registry. ensure your plugin adds
    // --add-host=host.docker.internal:host-gateway to docker run.
    const ociRepo = `oci://host.docker.internal:${registryPort}/charts`;

    const pubCfg: HelmPluginConfig = {
      chartPath: chartPathInWorkdir,
      helmImage: HELM_IMAGE,
      docsImage: DOCS_IMAGE,
      ociRepo,
    };
    const pubCtx = { logger, cwd: workdir } as unknown as PublishContext;

    await expect(publish(pubCfg, pubCtx)).resolves.toBeUndefined();

    const dist = path.join(workdir, 'dist', 'charts');
    const files = fs.readdirSync(dist);
    expect(files.some((f) => f.endsWith('.tgz'))).toBe(true);
  }, 240_000);
});
