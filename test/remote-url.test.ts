import { readFile } from 'node:fs/promises';
import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { RemoteUrl } from '../src/remote-url.js';

interface InsecureRemote {
  remote: string;
  webBase: string;
}

const insecure = JSON.parse(
  await readFile(
    new URL('fixtures/insecure-remotes.json', import.meta.url),
    'utf8',
  ),
) as Record<'ghes' | 'internal', InsecureRemote>;

const base = (text: string) => RemoteUrl.parse(text).webBase();

describe('RemoteUrl.webBase', () => {
  it.each([
    ['https://github.com/o/r.git', 'https://github.com/o/r'],
    ['https://github.com/o/r', 'https://github.com/o/r'],
    ['git@github.com:o/r.git', 'https://github.com/o/r'],
    ['ghes.corp:org/repo.git', 'https://ghes.corp/org/repo'],
    ['ghes.corp:8443/org/repo.git', 'https://ghes.corp/8443/org/repo'],
    ['ssh://git@github.com/o/r.git', 'https://github.com/o/r'],
    ['ssh://git@github.com:2222/o/r.git', 'https://github.com/o/r'],
    ['git://github.com/o/r.git', 'https://github.com/o/r'],
    ['https://ghes.corp:8443/o/r.git', 'https://ghes.corp:8443/o/r'],
    [insecure.ghes.remote, insecure.ghes.webBase],
    [insecure.internal.remote, insecure.internal.webBase],
    [
      'https://x-access-token:TOKEN@github.com/o/r.git',
      'https://github.com/o/r',
    ],
    ['https://user@ghe.example.test/o/r.git/', 'https://ghe.example.test/o/r'],
    ['git@ghe.example.test:o/r.git\n', 'https://ghe.example.test/o/r'],
    ['https://github.com/o/r///', 'https://github.com/o/r'],
    ['https://github.com///o/r.git/', 'https://github.com/o/r'],
    [`https://github.com/o/r${'/'.repeat(200_000)}`, 'https://github.com/o/r'],
    [`https://github.com${'/'.repeat(200_000)}o/r`, 'https://github.com/o/r'],
  ])('maps %s', (remote, expected) => {
    expect(base(remote)).toBe(expected);
  });

  it.each([
    ['file:///srv/git/r.git'],
    ['/srv/git/r.git'],
    ['../r.git'],
    ['r.git'],
    [''],
    ['https://github.com/'],
    ['git@gh-work:o/r.git'],
    [String.raw`C:\path\repo`],
    ['C:/path/repo'],
    ['git@[::1]:o/r'],
    ['file://server/share/repo'],
    ['ftp://example.com/o/r'],
  ])('derives nothing from %j', (remote) => {
    expect(base(remote)).toBeUndefined();
  });

  it('never lets a token reach the result', () => {
    expect(
      base('https://x-access-token:SECRET@github.com/o/r.git'),
    ).not.toContain('SECRET');
  });

  it('redacts credentials when printed', () => {
    expect(
      RemoteUrl.parse('https://u:tok3n@github.com/o/r.git').toString(),
    ).toBe('https://***@github.com/o/r.git');
    expect(RemoteUrl.parse('git@github.com:o/r.git').toString()).toBe(
      'git@github.com:o/r.git',
    );
  });
});

describe('RemoteUrl.releaseBase', () => {
  it.each([
    ['git@github.com:o/r.git', undefined, 'https://github.com/o/r'],
    [
      'git@github.com:o/r.git',
      'https://github.com/x/y',
      'https://github.com/o/r',
    ],
    ['git@gh-work:o/r.git', 'https://github.com/o/r', 'https://github.com/o/r'],
    ['/srv/git/r.git', 'https://github.com/o/r', 'https://github.com/o/r'],
    [
      'git@gitlab.com:o/r.git',
      'https://github.com/o/r',
      'https://github.com/o/r',
    ],
    ['git@gitlab.com:o/r.git', undefined, undefined],
    ['git@ghes.corp:o/r.git', 'https://ghes.corp/o/r', 'https://ghes.corp/o/r'],
    ['git@ghes.corp:o/r.git', 'git@ghes.corp:o/r.git', 'https://ghes.corp/o/r'],
    ['/srv/git/r.git', undefined, undefined],
  ])(
    'remote %s with repositoryUrl %s gives %s',
    (remote, repositoryUrl, expected) => {
      expect(
        RemoteUrl.parse(remote).releaseBase(
          repositoryUrl === undefined
            ? undefined
            : RemoteUrl.parse(repositoryUrl),
        ),
      ).toBe(expected);
    },
  );
});
