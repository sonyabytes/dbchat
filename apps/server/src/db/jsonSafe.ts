/**
 * Row cells cross the RPC boundary as `Schema.Unknown` inside a JSON
 * serializer, so anything that is not plain JSON has to be coerced first.
 * Drivers hand back `Date` (timestamp/timestamptz/date), `Buffer` /
 * `Uint8Array` (bytea, blob), `BigInt` (int8 when a parser is installed) and
 * driver-specific wrappers; all of those become strings here.
 */

const MAX_DEPTH = 8;

export const toJsonSafe = (value: unknown, depth = 0): unknown => {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "function":
    case "symbol":
      return String(value);
    default:
      break;
  }

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString("hex")}`;
  if (ArrayBuffer.isView(value)) return `\\x${Buffer.from(value.buffer as ArrayBuffer).toString("hex")}`;

  if (depth >= MAX_DEPTH) return String(value);

  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v, depth + 1));

  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJsonSafe(v, depth + 1);
    return out;
  }

  // Anything exotic (pg ranges, mysql Geometry, class instances…).
  return String(value);
};

export const toJsonSafeRow = (row: ReadonlyArray<unknown>): Array<unknown> => row.map((v) => toJsonSafe(v));

export const toJsonSafeRows = (rows: ReadonlyArray<ReadonlyArray<unknown>>): Array<Array<unknown>> =>
  rows.map(toJsonSafeRow);
