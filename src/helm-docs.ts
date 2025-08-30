import * as fs from 'fs';
import * as path from 'path';
import { DockerCliClient } from './docker/cli-client.js';
import { DockerImage } from './docker/image.js';
import type { DockerClient } from './docker/client.js';

export interface Logger {
  log: (m: string) => void;
  error: (m: string) => void;
}

/**
 * Public interface for README docs generation for a Helm chart.
 * Implementations may use Docker or a native binary.
 */
export interface HelmDocs {
  /**
   * Normalize README markers and generate docs for a chart.
   *
   * @param cwd Repo root.
   * @param chartPath Path to chart directory (contains Chart.yaml).
   * @param args Extra args for the docs tool (e.g., ["--template-files=README.md"]).
   * @param logger Logger for structured output.
   */
  generate(
    cwd: string,
    chartPath: string,
    args: string[],
    logger: Logger,
  ): Promise<void>;
}

/**
 * Sentinels around the values table region. The inner content is
 * replaced with the Go template call before running helm-docs.
 */
export const VALUES_TABLE_TEMPLATE = '{{ template "chart.valuesTable" . }}';
export const VALUES_TABLE_START_RE = /<!--\s*render\.chart\.valuesTable\s*-->/i;
export const VALUES_TABLE_END_RE = /<!--\s*end\.chart\.valuesTable\s*-->/i;
export const VALUES_TABLE_BLOCK_RE = new RegExp(
  String(VALUES_TABLE_START_RE).slice(1, -2) +
    '[\\s\\S]*?' +
    String(VALUES_TABLE_END_RE).slice(1, -2),
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
  let changed = false;
  const updated = content.replace(VALUES_TABLE_BLOCK_RE, (block) => {
    const start =
      block.match(VALUES_TABLE_START_RE)?.[0] ??
      '<!-- render.chart.valuesTable -->';
    const end =
      block.match(VALUES_TABLE_END_RE)?.[0] ?? '<!-- end.chart.valuesTable -->';
    changed = true;
    return `${start}\n${VALUES_TABLE_TEMPLATE}\n${end}`;
  });
  return { updated, changed };
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

export interface DockerHelmDocsOptions {
  image?: string;
  client?: DockerClient;
}

/**
 * Docker-backed helm-docs implementation.
 */
export class DockerHelmDocs implements HelmDocs {
  private readonly image: string;
  private readonly client: DockerClient;

  constructor(opts: DockerHelmDocsOptions = {}) {
    this.image = opts.image ?? 'jnorwood/helm-docs:v1.14.2';
    this.client = opts.client ?? new DockerCliClient();
  }

  async generate(
    cwd: string,
    chartPath: string,
    args: string[],
    logger: Logger,
  ): Promise<void> {
    const readmePath = path.join(cwd, chartPath, 'README.md');
    if (fs.existsSync(readmePath)) {
      const { changed } = normalizeReadmeValuesTableFile(readmePath);
      logger.log(
        changed
          ? 'helm-docs: normalized README valuesTable block(s)'
          : 'helm-docs: README normalization not needed (no markers found)',
      );
    } else {
      logger.log('helm-docs: README.md not found; skipping normalization');
    }

    const img = new DockerImage(this.image, cwd, logger, this.client);
    await img.run(['helm-docs', `--chart-search-root=${chartPath}`, ...args]);
  }
}
