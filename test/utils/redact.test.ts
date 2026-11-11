import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { redactCredentials } from '../../src/utils/redact.js';
import { RemoteUrl } from '../../src/remote-url.js';

describe('redactCredentials', () => {
  it.each([
    ['https://user:pw0rd@host/o/r.git', 'https://***@host/o/r.git'],
    [
      'https://x-access-token:abc123@github.com/o/r',
      'https://***@github.com/o/r',
    ],
    ['https://user:p@ss@host/o/r.git', 'https://***@host/o/r.git'],
    ['https://user:p%40ss@host/o/r.git', 'https://***@host/o/r.git'],
    ['HTTPS://user:pw0rd@host/o/r.git', 'HTTPS://***@host/o/r.git'],
    ['git+https://user:pw0rd@host/o/r', 'git+https://***@host/o/r'],
    [
      'oci://u:TOKENINURL@localhost:5000/charts',
      'oci://***@localhost:5000/charts',
    ],
    ['https://token123@host/o/r', 'https://***@host/o/r'],
    ['clone https://u:pw0rd@h/x failed', 'clone https://***@h/x failed'],
    ['https://host/o/r?token=abc123&x=1', 'https://host/o/r?token=***&x=1'],
    ['https://host/o?access_token=abc123', 'https://host/o?access_token=***'],
    ['AUTHORIZATION: basic dXNlcjpwdw==', 'AUTHORIZATION: ***'],
    ['< Authorization: Bearer abcdef', '< Authorization: ***'],
    ['using Bearer abc.def-ghi', 'using Bearer ***'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here', 'token *** here'],
    ['github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz', '***'],
    ['glpat-abcdefghijklmnopqrstuv', '***'],
  ])('redacts %s', (input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });

  it.each([
    'https://github.com/o/r.git',
    'git@github.com:o/r.git',
    'plain text with no secrets',
    'ssh://git@github.com/o/r.git'.replace('git@', ''),
  ])('leaves %s unchanged', (input) => {
    expect(redactCredentials(input)).toBe(input);
  });
});

const SCHEME = String.raw`([a-z][a-z0-9+.-]*:\/\/)`;
const CREDENTIALS_WITH_PASSWORD = new RegExp(
  [SCHEME, String.raw`[^\s/@:]*:\S*@`].join(''),
  'gi',
);
const CREDENTIALS_WITHOUT_PASSWORD = new RegExp(
  [SCHEME, String.raw`[^\s/@:]+@`].join(''),
  'gi',
);
const ANY_CREDENTIALS = new RegExp(
  [SCHEME, String.raw`[^\s/@]*@`].join(''),
  'gi',
);

/** The redaction as it was before the scan became linear, kept to prove equivalence. */
function redactWithRegexes(text: string): string {
  return text
    .replaceAll(CREDENTIALS_WITH_PASSWORD, '$1***@')
    .replaceAll(CREDENTIALS_WITHOUT_PASSWORD, '$1***@')
    .replaceAll(
      /([?&](?:access_token|token|password|private_token)=)[^&\s#'"]+/gi,
      '$1***',
    )
    .replaceAll(/\b((?:proxy-)?authorization)\s*:[^\r\n]*/gi, '$1: ***')
    .replaceAll(/\bbearer\s+[\w.~+/=-]+/gi, 'Bearer ***')
    .replaceAll(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[A-Za-z0-9_-]{16,})/g,
      '***',
    );
}

const PIECES = [
  'http',
  'HTTPS',
  'git+ssh',
  '1',
  '9a',
  '+',
  '.',
  '-',
  '_',
  '://',
  '://',
  '/',
  '//',
  ':',
  '@',
  '@',
  ' ',
  '\n',
  '\t',
  'user',
  'p@ss',
  'x',
  '%40',
  '\u00E9',
  '\u017F',
  '\u212A',
  '?token=',
  'ghp_',
];

/** A deterministic generator, so a failing input can be reproduced. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function generated(count: number): string[] {
  const random = generator(20_240_607);
  return Array.from({ length: count }, () => {
    const length = 1 + Math.floor(random() * 14);
    return Array.from(
      { length },
      () => PIECES[Math.floor(random() * PIECES.length)],
    ).join('');
  });
}

describe('redaction scan against the regular expressions it replaced', () => {
  it('redacts 60000 generated texts exactly as the regular expressions did', () => {
    for (const text of generated(60_000)) {
      expect(redactCredentials(text)).toBe(redactWithRegexes(text));
    }
  });

  it('prints 60000 generated remotes exactly as the regular expression did', () => {
    for (const text of generated(60_000)) {
      const old = text.trim().replaceAll(ANY_CREDENTIALS, '$1***@');
      expect(RemoteUrl.parse(text).toString()).toBe(old);
    }
  });

  it.each([
    ['a digit-only run does not make a scheme', '1://u:p@h x://u:p@h'],
    ['a later scheme in the same run still counts', '1://a:xyz://b:c@h'],
    ['a password may hold ://', 'https://u:a://b:c@h/o'],
    ['the last @ of the run ends the password', 'https://u:p@q@r z@s'],
  ])('keeps the edge case where %s', (_label, text) => {
    expect(redactCredentials(text)).toBe(redactWithRegexes(text));
  });

  it.each([
    ['repeated schemes without a password', 'http://a:'.repeat(50_000)],
    ['repeated schemes with a password', 'http://a:b@'.repeat(50_000)],
    ['one long scheme run', 'a'.repeat(200_000)],
    ['one long userinfo', `http://${'a'.repeat(200_000)}`],
    ['one long password', `http://u:${'@/'.repeat(100_000)}`],
  ])('stays fast on %s', (_label, text) => {
    const started = Date.now();
    redactCredentials(text);
    RemoteUrl.parse(text).toString();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
