/**
 * Postgres OID → type-name mapping for result-set columns.
 *
 * `pg` only hands back `dataTypeID` (an OID) on `result.fields`, so a column
 * that does not come straight from a table (`count(*)`, an expression, a CTE)
 * had no type at all before this. Resolution is three-tiered:
 *
 *  1. a static table of the built-in OIDs (no round-trip at all — these are
 *     fixed in `pg_type.dat` and never change);
 *  2. one `pg_type` sweep per pool, cached forever, which picks up enums,
 *     domains, composites and extension types (postgis, citext, …);
 *  3. `format_type(oid, -1)` for anything created after that sweep.
 *
 * Nothing here parses values: `int8`/`numeric` still arrive as strings from
 * `pg` (see `jsonSafe.ts`), the type name is only there so the UI can format.
 */
import * as Effect from "effect/Effect";

/** Built-in OIDs (stable across all Postgres versions). */
const BUILTIN: ReadonlyMap<number, string> = new Map<number, string>([
  [16, "bool"],
  [17, "bytea"],
  [18, "char"],
  [19, "name"],
  [20, "int8"],
  [21, "int2"],
  [22, "int2vector"],
  [23, "int4"],
  [24, "regproc"],
  [25, "text"],
  [26, "oid"],
  [27, "tid"],
  [28, "xid"],
  [29, "cid"],
  [114, "json"],
  [142, "xml"],
  [194, "pg_node_tree"],
  [600, "point"],
  [601, "lseg"],
  [602, "path"],
  [603, "box"],
  [604, "polygon"],
  [628, "line"],
  [650, "cidr"],
  [700, "float4"],
  [701, "float8"],
  [705, "unknown"],
  [718, "circle"],
  [790, "money"],
  [829, "macaddr"],
  [869, "inet"],
  [1033, "aclitem"],
  [1042, "bpchar"],
  [1043, "varchar"],
  [1082, "date"],
  [1083, "time"],
  [1114, "timestamp"],
  [1184, "timestamptz"],
  [1186, "interval"],
  [1266, "timetz"],
  [1560, "bit"],
  [1562, "varbit"],
  [1700, "numeric"],
  [1790, "refcursor"],
  [2249, "record"],
  [2250, "cstring"],
  [2278, "void"],
  [2950, "uuid"],
  [2970, "txid_snapshot"],
  [3220, "pg_lsn"],
  [3361, "pg_ndistinct"],
  [3402, "pg_dependencies"],
  [3614, "tsvector"],
  [3615, "tsquery"],
  [3642, "gtsvector"],
  [3734, "regconfig"],
  [3769, "regdictionary"],
  [3802, "jsonb"],
  [4072, "jsonpath"],
  [5069, "xid8"],
  // range types
  [3904, "int4range"],
  [3906, "numrange"],
  [3908, "tsrange"],
  [3910, "tstzrange"],
  [3912, "daterange"],
  [3926, "int8range"],
  // multirange types (PG 14+)
  [4451, "int4multirange"],
  [4532, "nummultirange"],
  [4533, "tsmultirange"],
  [4534, "tstzmultirange"],
  [4535, "datemultirange"],
  [4536, "int8multirange"],
  // arrays of the common scalars
  [143, "xml[]"],
  [199, "json[]"],
  [1000, "bool[]"],
  [1001, "bytea[]"],
  [1002, "char[]"],
  [1003, "name[]"],
  [1005, "int2[]"],
  [1007, "int4[]"],
  [1009, "text[]"],
  [1014, "bpchar[]"],
  [1015, "varchar[]"],
  [1016, "int8[]"],
  [1021, "float4[]"],
  [1022, "float8[]"],
  [1028, "oid[]"],
  [1115, "timestamp[]"],
  [1182, "date[]"],
  [1183, "time[]"],
  [1185, "timestamptz[]"],
  [1187, "interval[]"],
  [1231, "numeric[]"],
  [1270, "timetz[]"],
  [1561, "bit[]"],
  [1563, "varbit[]"],
  [2951, "uuid[]"],
  [3807, "jsonb[]"],
]);

/** Type name for a built-in OID, or `undefined` when it is not built in. */
export const builtinPgTypeName = (oid: number): string | undefined => BUILTIN.get(oid);

/** What we report when no tier could name the type. */
export const UNKNOWN_TYPE = "unknown";

export interface PgTypeRow {
  readonly oid: number;
  readonly name: string;
}

export interface PgTypeResolver {
  /** Names every OID in `oids`; misses become `"unknown"`. Never fails. */
  readonly resolve: (oids: ReadonlyArray<number>) => Effect.Effect<ReadonlyMap<number, string>>;
}

/**
 * `loadCatalog` is expected to be `select oid, typname from pg_type` and
 * `formatTypes` a `format_type(oid, -1)` lookup for the given OIDs. Both may
 * fail; failures degrade to the tier above (ultimately `"unknown"`).
 */
export const makePgTypeResolver = (options: {
  readonly loadCatalog: Effect.Effect<ReadonlyArray<PgTypeRow>, unknown>;
  readonly formatTypes: (oids: ReadonlyArray<number>) => Effect.Effect<ReadonlyArray<PgTypeRow>, unknown>;
}): PgTypeResolver => {
  const cache = new Map<number, string>();
  let catalogLoaded = false;

  const missing = (oids: ReadonlyArray<number>): Array<number> =>
    [...new Set(oids)].filter((oid) => oid > 0 && cache.get(oid) === undefined && BUILTIN.get(oid) === undefined);

  const merge = (rows: ReadonlyArray<PgTypeRow>) => {
    for (const row of rows) {
      if (Number.isFinite(row.oid) && typeof row.name === "string" && row.name.length > 0) {
        cache.set(row.oid, row.name);
      }
    }
  };

  const resolve = (oids: ReadonlyArray<number>): Effect.Effect<ReadonlyMap<number, string>> =>
    Effect.gen(function* () {
      let unresolved = missing(oids);

      if (unresolved.length > 0 && !catalogLoaded) {
        catalogLoaded = true;
        const rows = yield* options.loadCatalog.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<PgTypeRow>)));
        merge(rows);
        unresolved = missing(oids);
      }

      if (unresolved.length > 0) {
        const rows = yield* options
          .formatTypes(unresolved)
          .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<PgTypeRow>)));
        merge(rows);
      }

      const out = new Map<number, string>();
      for (const oid of oids) {
        out.set(oid, BUILTIN.get(oid) ?? cache.get(oid) ?? UNKNOWN_TYPE);
      }
      return out;
    });

  return { resolve };
};
