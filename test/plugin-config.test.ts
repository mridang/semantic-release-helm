import { describe, it, expect } from '@jest/globals';
import { HelmConfig, HelmPluginConfig } from '../src/plugin-config.js';
import { withEnv } from './utils/withenv.js';

describe('HelmConfig', () => {
  it('defaults: only chartPath provided', () => {
    const cfg = new HelmConfig({ chartPath: 'charts/app' } as HelmPluginConfig);

    expect({
      chartPath: cfg.getChartPath(),
      helmImage: cfg.getHelmImage(),
      docsImage: cfg.getDocsImage(),
      docsArgs: cfg.getDocsArgs(),
      gh: {
        enabled: cfg.isGhEnabled(),
        url: cfg.getGhUrl(),
        repo: cfg.getGhRepo(),
        branch: cfg.getGhBranch(),
        dir: cfg.getGhDir(),
      },
      oci: {
        enabled: cfg.isOciEnabled(),
        repo: cfg.getOciRepo(),
        insecure: cfg.getOciInsecure(),
        host: cfg.getOciHost(),
        port: cfg.getOciPort(),
        hostPort: cfg.getOciHostPort(),
        plainHttpFlag: cfg.getOciPlainHttpFlag(),
        insecureLoginFlag: cfg.getOciInsecureLoginFlag(),
        username: cfg.getOciUsername(),
        password: cfg.getOciPassword(),
        hasUser: cfg.hasOciUser(),
        hasPass: cfg.hasOciPass(),
      },
    }).toEqual({
      chartPath: 'charts/app',
      helmImage: 'alpine/helm:3.15.2',
      docsImage: 'jnorwood/helm-docs:v1.14.2',
      docsArgs: ['--template-files=README.md'],
      gh: {
        enabled: true,
        url: undefined,
        repo: 'origin',
        branch: 'gh-pages',
        dir: 'charts',
      },
      oci: {
        enabled: false,
        repo: undefined,
        insecure: false,
        host: undefined,
        port: undefined,
        hostPort: undefined,
        plainHttpFlag: '',
        insecureLoginFlag: '',
        username: undefined,
        password: undefined,
        hasUser: false,
        hasPass: false,
      },
    });
  });

  it('overrides: helmImage/docsImage/docsArgs respected', () => {
    const cfg = new HelmConfig({
      chartPath: 'x',
      helmImage: 'example/helm:9.9.9',
      docsImage: 'example/helm-docs:v2.0.0',
      docsArgs: ['--template-files=README.md.gotmpl', '--sort-values'],
    } as HelmPluginConfig);

    expect({
      helmImage: cfg.getHelmImage(),
      docsImage: cfg.getDocsImage(),
      docsArgs: cfg.getDocsArgs(),
    }).toEqual({
      helmImage: 'example/helm:9.9.9',
      docsImage: 'example/helm-docs:v2.0.0',
      docsArgs: ['--template-files=README.md.gotmpl', '--sort-values'],
    });
  });

  it('gh-pages: disabled and custom url/repo/branch/dir', () => {
    const cfg = new HelmConfig({
      chartPath: 'x',
      ghPages: {
        enabled: false,
        url: 'https://charts.example.test',
        repo: 'upstream',
        branch: 'pages',
        dir: 'helm',
      },
    } as HelmPluginConfig);

    expect({
      enabled: cfg.isGhEnabled(),
      url: cfg.getGhUrl(),
      repo: cfg.getGhRepo(),
      branch: cfg.getGhBranch(),
      dir: cfg.getGhDir(),
    }).toEqual({
      enabled: false,
      url: 'https://charts.example.test',
      repo: 'upstream',
      branch: 'pages',
      dir: 'helm',
    });
  });

  it('oci: enabled when ociRepo set, host/port parsed (no port)', () => {
    const cfg = new HelmConfig({
      chartPath: 'x',
      ociRepo: 'oci://ghcr.io/my-org/helm',
    } as HelmPluginConfig);

    expect({
      enabled: cfg.isOciEnabled(),
      repo: cfg.getOciRepo(),
      insecure: cfg.getOciInsecure(),
      host: cfg.getOciHost(),
      port: cfg.getOciPort(),
      hostPort: cfg.getOciHostPort(),
      plainHttpFlag: cfg.getOciPlainHttpFlag(),
      insecureLoginFlag: cfg.getOciInsecureLoginFlag(),
    }).toEqual({
      enabled: true,
      repo: 'oci://ghcr.io/my-org/helm',
      insecure: false,
      host: 'ghcr.io',
      port: undefined,
      hostPort: 'ghcr.io',
      plainHttpFlag: '',
      insecureLoginFlag: '',
    });
  });

  it('oci: host and port parsed when port present', () => {
    const cfg = new HelmConfig({
      chartPath: 'x',
      ociRepo: 'oci://registry.example.com:5000/ns/helm',
    } as HelmPluginConfig);

    expect({
      host: cfg.getOciHost(),
      port: cfg.getOciPort(),
      hostPort: cfg.getOciHostPort(),
    }).toEqual({
      host: 'registry.example.com',
      port: 5000,
      hostPort: 'registry.example.com:5000',
    });
  });

  it('oci: insecure flags when ociInsecure=true', () => {
    const cfg = new HelmConfig({
      chartPath: 'x',
      ociRepo: 'oci://ghcr.io/my-org/helm',
      ociInsecure: true,
    } as HelmPluginConfig);

    expect({
      insecure: cfg.getOciInsecure(),
      plainHttpFlag: cfg.getOciPlainHttpFlag(),
      insecureLoginFlag: cfg.getOciInsecureLoginFlag(),
    }).toEqual({
      insecure: true,
      plainHttpFlag: ' --plain-http',
      insecureLoginFlag: ' --insecure',
    });
  });

  it('creds: prefer config-provided username/password', () => {
    const cfg = new HelmConfig({
      chartPath: 'x',
      ociRepo: 'oci://ghcr.io/x/y',
      ociUsername: 'cfg-user',
      ociPassword: 'cfg-pass',
    } as HelmPluginConfig);

    expect({
      user: cfg.getOciUsername(),
      pass: cfg.getOciPassword(),
      hasUser: cfg.hasOciUser(),
      hasPass: cfg.hasOciPass(),
    }).toEqual({
      user: 'cfg-user',
      pass: 'cfg-pass',
      hasUser: true,
      hasPass: true,
    });
  });

  it('creds: fallback to env when not in config', () => {
    withEnv({ OCI_USERNAME: 'env-user', OCI_PASSWORD: 'env-pass' }, () => {
      const cfg = new HelmConfig({
        chartPath: 'x',
        ociRepo: 'oci://ghcr.io/x/y',
      } as HelmPluginConfig);

      expect({
        user: cfg.getOciUsername(),
        pass: cfg.getOciPassword(),
        hasUser: cfg.hasOciUser(),
        hasPass: cfg.hasOciPass(),
      }).toEqual({
        user: 'env-user',
        pass: 'env-pass',
        hasUser: true,
        hasPass: true,
      });
    });
  });

  it('creds: absent env yields undefined and false flags', () => {
    withEnv({ OCI_USERNAME: undefined, OCI_PASSWORD: undefined }, () => {
      const cfg = new HelmConfig({
        chartPath: 'x',
        ociRepo: 'oci://ghcr.io/x/y',
      } as HelmPluginConfig);

      expect({
        user: cfg.getOciUsername(),
        pass: cfg.getOciPassword(),
        hasUser: cfg.hasOciUser(),
        hasPass: cfg.hasOciPass(),
      }).toEqual({
        user: undefined,
        pass: undefined,
        hasUser: false,
        hasPass: false,
      });
    });
  });

  it('echo: chartPath and raw ociRepo returned', () => {
    const cfg = new HelmConfig({
      chartPath: 'charts/svc',
      ociRepo: 'oci://registry.acme.io/acme/svc',
    } as HelmPluginConfig);

    expect({
      chartPath: cfg.getChartPath(),
      ociRepo: cfg.getOciRepo(),
    }).toEqual({
      chartPath: 'charts/svc',
      ociRepo: 'oci://registry.acme.io/acme/svc',
    });
  });
});
