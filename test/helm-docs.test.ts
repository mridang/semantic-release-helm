import { expect } from '@jest/globals';
import fs from 'node:fs/promises';
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

test('normalizeReadmeValuesTableFile returns false when no markers', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-docs-no-markers-'));
  const file = path.join(tmp, 'README.md');
  await fs.writeFile(file, '# nothing here\n', 'utf8');

  const { changed } = await normalizeReadmeValuesTableFile(file);
  expect(changed).toBe(false);
});

test('normalizeReadmeValuesTableFile updates file in-place when markers exist', async () => {
  const tmp = await fs.mkdtemp(
    path.join(os.tmpdir(), 'helm-docs-with-markers-'),
  );
  const file = path.join(tmp, 'README.md');
  await fs.writeFile(
    file,
    '<!-- render.chart.valuesTable -->\nsome table\n<!-- end.chart.valuesTable -->\n',
    'utf8',
  );

  const { changed } = await normalizeReadmeValuesTableFile(file);
  expect(changed).toBe(true);

  const after = await fs.readFile(file, 'utf8');
  expect(after).toContain(VALUES_TABLE_TEMPLATE);
});
