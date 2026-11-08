/**
 * Whether a value is a plain object: not null and not an array.
 *
 * @param value Value to check.
 * @returns True for objects with string keys.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a string property of an untrusted object.
 *
 * @param record The object.
 * @param key Property name.
 * @returns The value when it is a string, otherwise undefined.
 */
export function stringAt(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Flatten nested objects into dotted keys with string values. Arrays and
 * other non-object values are not descended into; they are stringified.
 *
 * @param record The object to flatten.
 * @param prefix Dotted prefix for the keys, empty at the top level.
 * @returns A flat map such as `{ 'image.tag': 'v1' }`.
 */
export function flattenRecord(
  record: Readonly<Record<string, unknown>>,
  prefix = '',
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, value]) => {
      const dotted = prefix.length ? `${prefix}.${key}` : key;
      return isRecord(value)
        ? Object.entries(flattenRecord(value, dotted))
        : [[dotted, String(value)]];
    }),
  );
}
