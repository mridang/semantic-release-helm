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
import { execSync } from 'node:child_process';

const HELM_IMAGE = process.env.HELM_IMAGE ?? 'alpine/helm:3.15.2';
const DOCS_IMAGE = process.env.DOCS_IMAGE ?? 'jnorwood/helm-docs:v1.14.2';

function requireDocker(): void {
  try {
    execSync('docker version', { stdio: 'pipe' });
  } catch {
    throw new Error('Docker is required to run these integration tests.');
  }
}

function pull(image: string): void {
  execSync(`docker pull ${image}`, { stdio: 'pipe' });
}

describe('semantic-release-helm (integration, real Docker)', () => {
  let registry: StartedTestContainer | null = null;
  let registryHost: string = '127.0.0.1';
  let registryPort: number = 0;

  const logger = {
    log: (..._args: unknown[]) => {},
    error: (..._args: unknown[]) => {},
  };

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  let workdir: string;

  beforeAll(async () => {
    requireDocker();
    pull(HELM_IMAGE);
    pull(DOCS_IMAGE);

    registry = await new GenericContainer('registry:2')
      .withExposedPorts(5000)
      .withWaitStrategy(Wait.forLogMessage(/listening on/))
      .start();

    registryHost = registry.getHost();
    registryPort = registry.getMappedPort(5000);
  }, 120_000);

  afterAll(async () => {
    if (registry !== null) {
      await registry.stop();
    }
  });

  beforeEach(() => {
    // Copy the real chart into a fresh temp working dir
    workdir = path.join(__dirname, `.it-${Date.now()}`);
    fs.mkdirSync(workdir, { recursive: true });

    const srcChart = path.join(__dirname, 'chart');
    const destChart = path.join(workdir, 'charts', 'app');
    fs.mkdirSync(path.dirname(destChart), { recursive: true });

    // simple recursive copy
    const entries = fs.readdirSync(srcChart, { withFileTypes: true });
    for (const ent of entries) {
      const srcPath = path.join(srcChart, ent.name);
      const dstPath = path.join(destChart, ent.name);
      if (ent.isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true });
        for (const sub of fs.readdirSync(srcPath, { withFileTypes: true })) {
          const s = path.join(srcPath, sub.name);
          const d = path.join(dstPath, sub.name);
          if (sub.isDirectory()) {
            fs.mkdirSync(d, { recursive: true });
            // shallow copy is enough for test (two levels)
            for (const leaf of fs.readdirSync(s, { withFileTypes: true })) {
              const sl = path.join(s, leaf.name);
              const dl = path.join(d, leaf.name);
              fs.copyFileSync(sl, dl);
            }
          } else {
            fs.copyFileSync(s, d);
          }
        }
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it('verifyConditions succeeds with real chart and images', async () => {
    const cfg: HelmPluginConfig = {
      chartPath: 'charts/app',
      helmImage: HELM_IMAGE,
      docsImage: DOCS_IMAGE,
      docsArgs: ['--sort-values'],
    };
    const ctx = { logger, cwd: workdir } as unknown as VerifyConditionsContext;

    await expect(verifyConditions(cfg, ctx)).resolves.toBeUndefined();
  }, 120_000);

  it('prepare bumps version, lints, templates, docs, and packages', async () => {
    const cfg: HelmPluginConfig = {
      chartPath: 'charts/app',
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

    // optionally confirm helm-docs generated README.md
    const readme = path.join(workdir, 'charts', 'app', 'README.md');
    expect(fs.existsSync(readme)).toBe(true);
  }, 180_000);

  it('publish pushes to a real OCI registry (registry:2)', async () => {
    const oci = `oci://${registryHost}:${registryPort}/charts`;

    // First prepare to produce dist/charts/*.tgz
    const prepCfg: HelmPluginConfig = {
      chartPath: 'charts/app',
      helmImage: HELM_IMAGE,
      docsImage: DOCS_IMAGE,
    };
    const prepCtx = {
      logger,
      cwd: workdir,
      nextRelease: { version: '0.3.0' },
    } as unknown as PrepareContext;
    await prepare(prepCfg, prepCtx);

    // Now publish to the local OCI registry
    const pubCfg: HelmPluginConfig = {
      chartPath: 'charts/app',
      helmImage: HELM_IMAGE,
      docsImage: DOCS_IMAGE,
      ociRepo: oci,
    };
    const pubCtx = { logger, cwd: workdir } as unknown as PublishContext;

    // Note: from inside the helm container, contacting the registry at
    // host:port works because the Docker engine maps host:port properly.
    // If your Docker daemon differs, set HELM_IMAGE to a custom image
    // that supports host.docker.internal and adjust the URL accordingly.
    await expect(publish(pubCfg, pubCtx)).resolves.toBeUndefined();

    // sanity: ensure the tgz still exists after push
    const dist = path.join(workdir, 'dist', 'charts');
    const files = fs.readdirSync(dist);
    expect(files.some((f) => f.endsWith('.tgz'))).toBe(true);
  }, 240_000);
});
