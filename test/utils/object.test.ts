import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { isRecord, stringAt } from '../../src/utils/object.js';

describe('isRecord', () => {
  it('accepts plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('rejects null, arrays and primitives', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe('stringAt', () => {
  it('reads a string property', () => {
    expect(stringAt({ a: 'x' }, 'a')).toBe('x');
  });

  it('is undefined for a missing or non-string property', () => {
    expect(stringAt({ a: 1 }, 'a')).toBeUndefined();
    expect(stringAt({}, 'a')).toBeUndefined();
  });
});
