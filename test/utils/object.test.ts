import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { flattenRecord, isRecord, stringAt } from '../../src/utils/object.js';

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

describe('flattenRecord', () => {
  it('flattens nested objects into dotted keys', () => {
    expect(
      flattenRecord({ image: { tag: 'v1', pull: { policy: 'Always' } } }),
    ).toEqual({ 'image.tag': 'v1', 'image.pull.policy': 'Always' });
  });

  it('stringifies scalars, arrays and null without descending', () => {
    expect(
      flattenRecord({ n: 3, b: true, list: ['a', 'b'], nothing: null }),
    ).toEqual({ n: '3', b: 'true', list: 'a,b', nothing: 'null' });
  });

  it('applies a prefix', () => {
    expect(flattenRecord({ a: 1 }, 'root')).toEqual({ 'root.a': '1' });
  });

  it('returns an empty map for an empty object', () => {
    expect(flattenRecord({})).toEqual({});
  });
});
