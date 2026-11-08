import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import {
  codeOf,
  messageOf,
  signalOf,
  statusOf,
} from '../../src/utils/error.js';

describe('messageOf', () => {
  it('reads the message of an Error', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
  });

  it('uses the string form of anything else', () => {
    expect(messageOf('plain')).toBe('plain');
    expect(messageOf(42)).toBe('42');
    expect(messageOf(undefined)).toBe('undefined');
  });
});

describe('codeOf', () => {
  it('reads the code of a coded error', () => {
    expect(codeOf(Object.assign(new Error('x'), { code: 'EBOOM' }))).toBe(
      'EBOOM',
    );
  });

  it('is undefined for an error without a code, a non-string code or a non-object', () => {
    expect(codeOf(new Error('x'))).toBeUndefined();
    expect(codeOf(Object.assign(new Error('x'), { code: 5 }))).toBeUndefined();
    expect(codeOf('E1')).toBeUndefined();
  });
});

describe('statusOf and signalOf', () => {
  it('read the exit status and the signal of a child-process error', () => {
    const error = Object.assign(new Error('x'), {
      status: 3,
      signal: 'SIGTERM',
    });
    expect(statusOf(error)).toBe(3);
    expect(signalOf(error)).toBe('SIGTERM');
  });

  it('are undefined when absent or of the wrong type', () => {
    expect(
      statusOf(Object.assign(new Error('x'), { status: '3' })),
    ).toBeUndefined();
    expect(
      signalOf(Object.assign(new Error('x'), { signal: 9 })),
    ).toBeUndefined();
    expect(statusOf('x')).toBeUndefined();
    expect(signalOf(undefined)).toBeUndefined();
  });
});

describe('messageOf for errors without a message', () => {
  it('falls back to the code, the first inner error, then the name', () => {
    expect(
      messageOf(Object.assign(new Error(''), { code: 'ECONNREFUSED' })),
    ).toBe('ECONNREFUSED');
    expect(
      messageOf(Object.assign(new Error(''), { errors: [new Error('inner')] })),
    ).toBe('inner');
    expect(messageOf(new Error(''))).toBe('Error');
  });
});
