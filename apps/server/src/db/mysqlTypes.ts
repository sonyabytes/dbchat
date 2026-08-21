/**
 * MySQL result-set field metadata → `ColumnMeta`.
 *
 * `mysql2` reports a wire-protocol `columnType` byte plus a `flags` bitmask on
 * every `FieldPacket`; that is all the server sends for a result set, so the
 * mapping below is the only way to name the columns of an ad-hoc query (a
 * `count(*)`, a join, an expression) without a second information_schema round
 * trip. The distinctions the byte alone cannot make (`text` vs `blob`,
 * `varchar` vs `varbinary`) come from the BINARY flag / charset 63.
 */
import type { ColumnMeta } from "@dbchat/contracts";

/** Wire-protocol type bytes (mysql2 `lib/constants/types.js`). */
export const MYSQL_TYPE = {
  DECIMAL: 0x00,
  TINY: 0x01,
  SHORT: 0x02,
  LONG: 0x03,
  FLOAT: 0x04,
  DOUBLE: 0x05,
  NULL: 0x06,
  TIMESTAMP: 0x07,
  LONGLONG: 0x08,
  INT24: 0x09,
  DATE: 0x0a,
  TIME: 0x0b,
  DATETIME: 0x0c,
  YEAR: 0x0d,
  NEWDATE: 0x0e,
  VARCHAR: 0x0f,
  BIT: 0x10,
  VECTOR: 0xf2,
  JSON: 0xf5,
  NEWDECIMAL: 0xf6,
  ENUM: 0xf7,
  SET: 0xf8,
  TINY_BLOB: 0xf9,
  MEDIUM_BLOB: 0xfa,
  LONG_BLOB: 0xfb,
  BLOB: 0xfc,
  VAR_STRING: 0xfd,
  STRING: 0xfe,
  GEOMETRY: 0xff,
} as const;

/** Field flags (mysql2 `lib/constants/field_flags.js`). */
export const MYSQL_FLAG = {
  NOT_NULL: 1,
  PRI_KEY: 2,
  UNIQUE_KEY: 4,
  MULTIPLE_KEY: 8,
  BLOB: 16,
  UNSIGNED: 32,
  ZEROFILL: 64,
  BINARY: 128,
  ENUM: 256,
  AUTO_INCREMENT: 512,
  TIMESTAMP: 1024,
  SET: 2048,
} as const;

/** `charsetNr === 63` is `binary`; anything else is a text collation. */
const BINARY_CHARSET = 63;

export interface MysqlField {
  readonly name: string;
  /** `columnType` on modern mysql2; `type` on older packets. */
  readonly columnType?: number | undefined;
  readonly type?: number | undefined;
  /** Numeric bitmask normally; mysql2 can hand back the decoded string list. */
  readonly flags?: number | ReadonlyArray<string> | undefined;
  readonly characterSet?: number | undefined;
  readonly charsetNr?: number | undefined;
  /** MariaDB 10.5+ extended metadata (`uuid`, `inet6`, `point`, …). */
  readonly extendedTypeName?: string | undefined;
}

const FLAG_NAMES: Record<string, number> = {
  NOT_NULL: MYSQL_FLAG.NOT_NULL,
  PRI_KEY: MYSQL_FLAG.PRI_KEY,
  UNIQUE_KEY: MYSQL_FLAG.UNIQUE_KEY,
  MULTIPLE_KEY: MYSQL_FLAG.MULTIPLE_KEY,
  BLOB: MYSQL_FLAG.BLOB,
  UNSIGNED: MYSQL_FLAG.UNSIGNED,
  ZEROFILL: MYSQL_FLAG.ZEROFILL,
  BINARY: MYSQL_FLAG.BINARY,
  ENUM: MYSQL_FLAG.ENUM,
  AUTO_INCREMENT: MYSQL_FLAG.AUTO_INCREMENT,
  TIMESTAMP: MYSQL_FLAG.TIMESTAMP,
  SET: MYSQL_FLAG.SET,
};

/** mysql2 sometimes decodes `flags` into a string array; normalise to a mask. */
export const flagsMask = (flags: MysqlField["flags"]): number => {
  if (typeof flags === "number") return flags;
  if (Array.isArray(flags)) {
    let mask = 0;
    for (const f of flags) mask |= FLAG_NAMES[String(f).toUpperCase()] ?? 0;
    return mask;
  }
  return 0;
};

/** Base SQL type name for a wire type byte + flags/charset context. */
export const mysqlTypeName = (field: MysqlField): string => {
  if (field.extendedTypeName !== undefined && field.extendedTypeName.length > 0) return field.extendedTypeName;

  const code = field.columnType ?? field.type;
  if (code === undefined) return "unknown";

  const flags = flagsMask(field.flags);
  const charset = field.characterSet ?? field.charsetNr;
  // `BINARY` flag or the binary charset means the payload is bytes, not text.
  const isBinary = charset === BINARY_CHARSET || (charset === undefined && (flags & MYSQL_FLAG.BINARY) !== 0);
  const unsigned = (flags & MYSQL_FLAG.UNSIGNED) !== 0 ? " unsigned" : "";

  switch (code) {
    case MYSQL_TYPE.TINY:
      return `tinyint${unsigned}`;
    case MYSQL_TYPE.SHORT:
      return `smallint${unsigned}`;
    case MYSQL_TYPE.INT24:
      return `mediumint${unsigned}`;
    case MYSQL_TYPE.LONG:
      return `int${unsigned}`;
    case MYSQL_TYPE.LONGLONG:
      return `bigint${unsigned}`;
    case MYSQL_TYPE.FLOAT:
      return `float${unsigned}`;
    case MYSQL_TYPE.DOUBLE:
      return `double${unsigned}`;
    case MYSQL_TYPE.DECIMAL:
    case MYSQL_TYPE.NEWDECIMAL:
      return `decimal${unsigned}`;
    case MYSQL_TYPE.BIT:
      return "bit";
    case MYSQL_TYPE.YEAR:
      return "year";
    case MYSQL_TYPE.DATE:
    case MYSQL_TYPE.NEWDATE:
      return "date";
    case MYSQL_TYPE.TIME:
      return "time";
    case MYSQL_TYPE.DATETIME:
      return "datetime";
    case MYSQL_TYPE.TIMESTAMP:
      return "timestamp";
    case MYSQL_TYPE.JSON:
      return "json";
    case MYSQL_TYPE.VECTOR:
      return "vector";
    case MYSQL_TYPE.GEOMETRY:
      return "geometry";
    case MYSQL_TYPE.ENUM:
      return "enum";
    case MYSQL_TYPE.SET:
      return "set";
    case MYSQL_TYPE.TINY_BLOB:
      return isBinary ? "tinyblob" : "tinytext";
    case MYSQL_TYPE.MEDIUM_BLOB:
      return isBinary ? "mediumblob" : "mediumtext";
    case MYSQL_TYPE.LONG_BLOB:
      return isBinary ? "longblob" : "longtext";
    case MYSQL_TYPE.BLOB:
      return isBinary ? "blob" : "text";
    case MYSQL_TYPE.VARCHAR:
    case MYSQL_TYPE.VAR_STRING:
      // ENUM/SET arrive as VAR_STRING with the matching flag set.
      if ((flags & MYSQL_FLAG.ENUM) !== 0) return "enum";
      if ((flags & MYSQL_FLAG.SET) !== 0) return "set";
      return isBinary ? "varbinary" : "varchar";
    case MYSQL_TYPE.STRING:
      if ((flags & MYSQL_FLAG.ENUM) !== 0) return "enum";
      if ((flags & MYSQL_FLAG.SET) !== 0) return "set";
      return isBinary ? "binary" : "char";
    case MYSQL_TYPE.NULL:
      return "null";
    default:
      return "unknown";
  }
};

/** Full `ColumnMeta` for one result-set field. */
export const mysqlColumnMeta = (field: MysqlField): ColumnMeta => {
  const flags = flagsMask(field.flags);
  return {
    name: field.name,
    type: mysqlTypeName(field),
    nullable: (flags & MYSQL_FLAG.NOT_NULL) === 0,
    isPrimaryKey: (flags & MYSQL_FLAG.PRI_KEY) !== 0,
  };
};
