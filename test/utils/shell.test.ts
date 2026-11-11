import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { quoteWord, shQuote } from '../../src/utils/shell.js';

describe('shQuote', () => {
  it('single-quotes and escapes embedded single quotes', () => {
    expect(shQuote('a b')).toBe("'a b'");
    expect(shQuote("a'b")).toBe(String.raw`'a'\''b'`);
  });
});

describe('quoteWord', () => {
  it('leaves words made of literal characters bare', () => {
    expect(quoteWord('--volume=/a:/b:ro')).toBe('--volume=/a:/b:ro');
    expect(quoteWord('alpine/helm:3.15.2')).toBe('alpine/helm:3.15.2');
  });

  it.each(['a b', 'a;b', '$(id)', '', 'a\n', "it's", '`x`', 'a|b'])(
    'quotes %j',
    (word) => {
      expect(quoteWord(word)).toBe(shQuote(word));
    },
  );
});
