import { expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeReadmeValuesTableContent,
  normalizeReadmeValuesTableFile,
  VALUES_TABLE_TEMPLATE,
} from '../src/helm-docs.js';

test('normalizeReadmeValuesTableContent replaces inner content and preserves sentinels', () => {
  const before = [
    '# Title',
    '<!-- render.chart.valuesTable -->',
    'old stuff that will be replaced',
    '<!-- end.chart.valuesTable -->',
    'tail',
  ].join('\n');

  const { updated, changed } = normalizeReadmeValuesTableContent(before);

  expect(changed).toBe(true);
  expect(updated).toContain('<!-- render.chart.valuesTable -->');
  expect(updated).toContain('<!-- end.chart.valuesTable -->');
  expect(updated).toContain(VALUES_TABLE_TEMPLATE);
  expect(updated).not.toContain('old stuff that will be replaced');
});

test('normalizeReadmeValuesTableContent handles multiple blocks and odd spacing', () => {
  const before = [
    '<!--   render.chart.valuesTable   -->',
    'x',
    '<!-- end.chart.valuesTable -->',
    'middle',
    '<!-- render.chart.valuesTable -->',
    'y',
    '<!--    end.chart.valuesTable    -->',
  ].join('\n');

  const { updated, changed } = normalizeReadmeValuesTableContent(before);

  expect(changed).toBe(true);
  expect(
    updated.match(/{{\s*template\s*"chart\.valuesTable"\s*\.\s*}}/g)?.length,
  ).toBe(2);
});

test('normalizeReadmeValuesTableFile returns false when no markers', () => {
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-docs-no-markers-'));
  const file = path.join(tmp, 'README.md');
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
  fs.writeFileSync(file, '# nothing here\n', 'utf8');

  const { changed } = normalizeReadmeValuesTableFile(file);
  expect(changed).toBe(false);
});

test('normalizeReadmeValuesTableFile updates file in-place when markers exist', () => {
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-docs-with-markers-'));
  const file = path.join(tmp, 'README.md');
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
  fs.writeFileSync(
    file,
    '<!-- render.chart.valuesTable -->\nsome table\n<!-- end.chart.valuesTable -->\n',
    'utf8',
  );

  const { changed } = normalizeReadmeValuesTableFile(file);
  expect(changed).toBe(true);

  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper
  const after = fs.readFileSync(file, 'utf8');
  expect(after).toContain(VALUES_TABLE_TEMPLATE);
});
