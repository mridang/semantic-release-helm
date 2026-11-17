import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { isRecord } from '../../src/utils/object.js';

/**
 * One chart version in a Helm repository index.
 */
interface IndexEntry {
  readonly version: string;
  readonly urls: readonly string[];
  readonly [key: string]: unknown;
}

/**
 * A Helm repository index, as the tests read it back.
 */
export interface IndexDocument {
  readonly apiVersion: string;
  readonly entries: Readonly<Partial<Record<string, readonly IndexEntry[]>>>;
  readonly generated?: string;
}

/**
 * Whether a parsed value is one chart version of an index.
 * @param value - The parsed value.
 * @returns True when it has a version and a list of urls.
 */
function isIndexEntry(value: unknown): value is IndexEntry {
  return (
    isRecord(value) &&
    typeof value.version === 'string' &&
    Array.isArray(value.urls) &&
    value.urls.every((url: unknown) => typeof url === 'string')
  );
}

/**
 * Whether a parsed value is a Helm repository index.
 * @param value - The parsed value.
 * @returns True when every entry of every chart is a chart version.
 */
function isIndexDocument(value: unknown): value is IndexDocument {
  return (
    isRecord(value) &&
    typeof value.apiVersion === 'string' &&
    isRecord(value.entries) &&
    Object.values(value.entries).every(
      (versions) => Array.isArray(versions) && versions.every(isIndexEntry),
    )
  );
}

/**
 * Parse the text of an index.yaml.
 * @param text - The YAML text.
 * @returns The index.
 * @throws When the text is not a Helm repository index.
 */
function parseIndexYaml(text: string): IndexDocument {
  const parsed: unknown = parse(text);
  if (!isIndexDocument(parsed)) {
    throw new TypeError('Expected a Helm repository index');
  }
  return parsed;
}

/**
 * Read an index.yaml from disk.
 * @param file - Path of the index.yaml.
 * @returns The index.
 * @throws When the file is not a Helm repository index.
 */
export async function readIndexYaml(file: string): Promise<IndexDocument> {
  return parseIndexYaml(await readFile(file, 'utf8'));
}
