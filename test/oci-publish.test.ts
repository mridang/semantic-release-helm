import { describe, expect, it } from '@jest/globals';
import { buildOciScript } from '../src/oci-publish.js';

const BASE = {
  hostPort: 'reg.example.test:5000',
  repo: 'oci://reg.example.test:5000/charts',
  insecure: false,
  username: 'user',
  hasPassword: true,
  files: ['dist/charts/app-1.0.0.tgz'],
} as const;

describe('buildOciScript', () => {
  it('logs in with the password read from the environment, then pushes', () => {
    expect(buildOciScript(BASE)).toBe(
      'helm registry login --username=user --password="$OCI_PASSWORD" reg.example.test:5000' +
        ' && helm push dist/charts/app-1.0.0.tgz oci://reg.example.test:5000/charts',
    );
  });

  it('never contains a password value, whatever it is', () => {
    expect(buildOciScript(BASE)).not.toContain('S3cr3t$x');
  });

  it('writes the insecure registry config and adds the insecure flags', () => {
    const script = buildOciScript({ ...BASE, insecure: true });
    expect(script).toBe(
      [
        'mkdir --parents /root/.config/helm/registry',
        `printf %s '{"auths":{"reg.example.test:5000":{"insecure":true}}}' > /root/.config/helm/registry/config.json`,
        'helm registry login --insecure --username=user --password="$OCI_PASSWORD" reg.example.test:5000',
        'helm push dist/charts/app-1.0.0.tgz oci://reg.example.test:5000/charts --plain-http',
      ].join(' && '),
    );
  });

  it('skips the login without a username, a password or a host', () => {
    expect(buildOciScript({ ...BASE, username: undefined })).not.toContain(
      'login',
    );
    expect(buildOciScript({ ...BASE, hasPassword: false })).not.toContain(
      'login',
    );
    expect(buildOciScript({ ...BASE, hostPort: undefined })).not.toContain(
      'login',
    );
  });

  it('pushes every packaged chart in order', () => {
    const script = buildOciScript({
      ...BASE,
      username: undefined,
      files: ['dist/charts/a-1.tgz', 'dist/charts/b-2.tgz'],
    });
    expect(script).toBe(
      'helm push dist/charts/a-1.tgz oci://reg.example.test:5000/charts && helm push dist/charts/b-2.tgz oci://reg.example.test:5000/charts',
    );
  });

  it('single-quotes values that contain shell metacharacters', () => {
    const script = buildOciScript({
      ...BASE,
      username: "a'; id; '",
      files: ['dist/charts/my chart.tgz'],
      repo: 'oci://h/c; id',
    });
    expect(script).toContain(`--username='a'\\''; id; '\\'''`);
    expect(script).toContain(
      `helm push 'dist/charts/my chart.tgz' 'oci://h/c; id'`,
    );
  });
});
