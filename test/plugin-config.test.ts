import { describe, it, expect } from '@jest/globals';
import { HelmConfig, HelmPluginConfig } from '../src/plugin-config.js';
import { withEnv } from './utils/withenv.js';

/** An unset value, declared without a literal `undefined` so it can be passed explicitly. */
let absent: undefined;

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
      },
      oci: {
        enabled: cfg.isOciEnabled(),
        repo: cfg.getOciRepo(),
        insecure: cfg.getOciInsecure(),
        host: cfg.getOciHost(),
        port: cfg.getOciPort(),
        hostPort: cfg.getOciHostPort(),
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
        repo: 'origin',
        branch: 'gh-pages',
      },
      oci: {
        enabled: false,
        insecure: false,
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
      },
    } as HelmPluginConfig);

    expect({
      enabled: cfg.isGhEnabled(),
      url: cfg.getGhUrl(),
      repo: cfg.getGhRepo(),
      branch: cfg.getGhBranch(),
    }).toEqual({
      enabled: false,
      url: 'https://charts.example.test',
      repo: 'upstream',
      branch: 'pages',
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
    }).toEqual({
      enabled: true,
      repo: 'oci://ghcr.io/my-org/helm',
      insecure: false,
      host: 'ghcr.io',
      hostPort: 'ghcr.io',
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
    }).toEqual({
      insecure: true,
    });
  });
});

describe('HelmConfig', () => {
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
    withEnv({ OCI_USERNAME: absent, OCI_PASSWORD: absent }, () => {
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

describe('HelmConfig with null values from a JSON or YAML config file', () => {
  const fromFile = (json: string): HelmConfig =>
    new HelmConfig(JSON.parse(json));

  it('treats null like an unset option for every option with a default', () => {
    const cfg = fromFile(
      JSON.stringify({
        chartPath: 'c',
        templateValues: null,
        ociRepo: null,
        ociInsecure: null,
        ociUsername: null,
        ociPassword: null,
        docsArgs: null,
        helmImage: null,
        docsImage: null,
        ghPages: null,
      }),
    );
    expect({
      templateValues: cfg.getTemplateValues(),
      ociEnabled: cfg.isOciEnabled(),
      ociInsecure: cfg.getOciInsecure(),
      docsArgs: cfg.getDocsArgs(),
      helmImage: cfg.getHelmImage(),
      docsImage: cfg.getDocsImage(),
      gh: [cfg.isGhEnabled(), cfg.getGhRepo(), cfg.getGhBranch()],
      ociRepo: cfg.getOciRepo(),
      ghUrl: cfg.getGhUrl(),
    }).toEqual({
      ociEnabled: false,
      ociInsecure: false,
      docsArgs: ['--template-files=README.md'],
      helmImage: 'alpine/helm:3.15.2',
      docsImage: 'jnorwood/helm-docs:v1.14.2',
      gh: [true, 'origin', 'gh-pages'],
    });
  });

  it('treats null ghPages members like unset ones', () => {
    const cfg = fromFile(
      '{"chartPath":"c","ghPages":{"enabled":null,"repo":null,"branch":null,"url":null}}',
    );
    expect([cfg.isGhEnabled(), cfg.getGhRepo(), cfg.getGhBranch()]).toEqual([
      true,
      'origin',
      'gh-pages',
    ]);
  });

  it('keeps false as a real value', () => {
    const cfg = fromFile(
      '{"chartPath":"c","ociInsecure":false,"ghPages":{"enabled":false}}',
    );
    expect([cfg.getOciInsecure(), cfg.isGhEnabled()]).toEqual([false, false]);
  });

  it('decides each publish mode from one predicate', () => {
    expect(fromFile('{"chartPath":"c"}').isOciEnabled()).toBe(false);
    expect(fromFile('{"chartPath":"c","ociRepo":""}').isOciEnabled()).toBe(
      false,
    );
    expect(
      fromFile('{"chartPath":"c","ociRepo":"oci://r/c"}').isOciEnabled(),
    ).toBe(true);
    expect(fromFile('{"chartPath":"c"}').isGhEnabled()).toBe(true);
  });
});
