import * as fs from 'node:fs';

/**
 * Sentinels around the values table region. The inner content is
 * replaced with the Go template call before running helm-docs.
 */
export const VALUES_TABLE_TEMPLATE = '{{ template "chart.valuesTable" . }}';
const VALUES_TABLE_START_RE = /<!--\s*render\.chart\.valuesTable\s*-->/i;
const VALUES_TABLE_END_RE = /<!--\s*end\.chart\.valuesTable\s*-->/i;
const VALUES_TABLE_BLOCK_RE = new RegExp(
  VALUES_TABLE_START_RE.source + '[\\s\\S]*?' + VALUES_TABLE_END_RE.source,
  'gi',
);

/**
 * Rewrites each valuesTable block to:
 *   <!-- render.chart.valuesTable -->
 *   {{ template "chart.valuesTable" . }}
 *   <!-- end.chart.valuesTable -->
 */
export function normalizeReadmeValuesTableContent(content: string): {
  updated: string;
  changed: boolean;
} {
  const updated = content.replace(VALUES_TABLE_BLOCK_RE, (block) => {
    const start =
      block.match(VALUES_TABLE_START_RE)?.[0] ??
      '<!-- render.chart.valuesTable -->';
    const end =
      block.match(VALUES_TABLE_END_RE)?.[0] ?? '<!-- end.chart.valuesTable -->';
    return `${start}\n${VALUES_TABLE_TEMPLATE}\n${end}`;
  });
  return { updated, changed: content.search(VALUES_TABLE_BLOCK_RE) !== -1 };
}

/**
 * Normalize README on disk (if present). Writes only when changes occur.
 */
export function normalizeReadmeValuesTableFile(absPath: string): {
  changed: boolean;
} {
  if (!fs.existsSync(absPath)) return { changed: false };
  const original = fs.readFileSync(absPath, 'utf8');
  const { updated, changed } = normalizeReadmeValuesTableContent(original);
  if (changed) fs.writeFileSync(absPath, updated, 'utf8');
  return { changed };
}
