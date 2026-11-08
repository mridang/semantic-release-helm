import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { redactCredentials, redactError } from '../../src/utils/redact.js';

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

describe('redactError', () => {
  it('redacts message, stdout and stderr and keeps code and status', () => {
    const original = Object.assign(new Error('failed https://u:pw0rd@h/x'), {
      code: 'E1',
      status: 3,
      stdout: 'out https://u:pw0rd@h/x',
      stderr: 'err ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    });
    const copy = redactError(original);
    expect(copy.message).toBe('failed https://***@h/x');
    expect(copy).toMatchObject({
      code: 'E1',
      status: 3,
      stdout: 'out https://***@h/x',
      stderr: 'err ***',
    });
  });

  it('wraps a thrown string', () => {
    expect(redactError('https://u:pw0rd@h/x').message).toBe('https://***@h/x');
  });
});
