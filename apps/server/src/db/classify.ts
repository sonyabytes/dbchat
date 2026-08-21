/**
 * SQL read/write classification.
 *
 * Two independent gates, both must agree before a statement is called `read`:
 *  1. a lexical gate — quote/comment-aware statement splitting plus a
 *     leading-keyword allow-list and a token deny-list (`insert`, `into`,
 *     `delete`, `copy`, …). This catches the shapes `node-sql-parser` either
 *     mis-parses or refuses to parse (`copy`, `explain analyze delete`, …).
 *  2. an AST gate — `node-sql-parser`. If it cannot parse the statement we
 *     fall back to the lexical gate only for statements whose leading keyword
 *     is unambiguously introspective (`show` / `explain` / `describe`);
 *     anything else that fails to parse is treated as unknown ⇒ not read-only.
 *
 * The parser alone is bypassable, so this is deliberately belt-and-braces;
 * transactional drivers additionally run reads inside a READ ONLY transaction.
 */
import type { Parser as SqlParser } from "node-sql-parser";

export type Dialect = "postgres" | "mysql" | "sqlite" | "bigquery";

export type StatementKind = "read" | "write" | "ddl" | "other";

export interface ClassifiedStatement {
  /** The statement text with the trailing `;` removed. */
  readonly sql: string;
  readonly kind: StatementKind;
  readonly reason?: string;
}

export interface ReadOnlyVerdict {
  readonly readOnly: boolean;
  readonly statements: number;
  readonly reason?: string;
}

/** node-sql-parser dialect names. */
const parserDialect: Record<Dialect, string> = {
  postgres: "postgresql",
  mysql: "mysql",
  sqlite: "sqlite",
  bigquery: "bigquery",
};

/** Leading keywords that may begin a read-only statement. */
const READ_LEADING = new Set([
  "select",
  "with",
  "show",
  "explain",
  "describe",
  "desc",
  "table",
  "values",
]);

/** Leading keywords that never parse but are known-introspective. */
const INTROSPECTIVE_LEADING = new Set(["show", "explain", "describe", "desc"]);

/**
 * Tokens that must not appear anywhere in a statement (after comments and
 * literals are scrubbed) for it to count as read-only. `into` is here so that
 * `SELECT … INTO new_table` is rejected alongside `INSERT INTO`.
 */
const DENY_TOKENS = new Set([
  "insert", "update", "delete", "merge", "upsert", "replace", "into",
  "truncate", "drop", "create", "alter", "rename", "comment", "cluster",
  "grant", "revoke", "reindex", "vacuum", "refresh", "lock",
  "copy", "call", "do", "exec", "execute", "prepare", "deallocate",
  "set", "reset", "discard", "listen", "unlisten", "notify",
  "begin", "start", "commit", "rollback", "savepoint", "release",
  "attach", "detach", "load", "import", "export", "handler",
  "pragma", "vacuum", "nextval", "setval",
]);

/**
 * Functions that are legal inside a READ ONLY transaction but still have side
 * effects (kill sessions, take locks, sleep, touch the filesystem, reach out to
 * other databases, load code). Matched against every identifier token, by exact
 * name or by prefix (entries ending in `*`).
 */
const DENY_FUNCTIONS: Record<Dialect, ReadonlyArray<string>> = {
  postgres: [
    "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_rotate_logfile",
    "pg_advisory_*", "pg_try_advisory_*", "dblink*", "pg_read_*", "pg_ls_*", "pg_stat_file",
    "lo_*", "pg_sleep*", "copy_*", "pg_file_*", "pg_logical_*", "pg_replication_*",
    "pg_create_*", "pg_drop_*", "pg_switch_wal", "pg_promote", "pg_notify", "set_config",
  ],
  mysql: ["sleep", "benchmark", "load_file", "sys_exec", "sys_eval", "get_lock", "release_lock", "release_all_locks", "master_pos_wait", "source_pos_wait"],
  sqlite: ["load_extension", "writefile", "readfile", "fsdir", "edit"],
  bigquery: [],
};

const deniedFunction = (scrubbed: string, dialect: Dialect): string | undefined => {
  const re = /[A-Za-z_][A-Za-z_0-9]*/g;
  const rules = DENY_FUNCTIONS[dialect];
  let m: RegExpExecArray | null;
  while ((m = re.exec(scrubbed)) !== null) {
    const t = m[0].toLowerCase();
    for (const rule of rules) {
      if (rule.endsWith("*") ? t.startsWith(rule.slice(0, -1)) : t === rule) return t;
    }
  }
  return undefined;
};

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/**
 * Split on `;` while respecting single quotes (with `''` escapes), double
 * quotes, backticks, `--` / `#` line comments, `/* *\/` block comments and
 * Postgres dollar-quoted strings.
 */
export const splitStatements = (sql: string, dialect: Dialect): ReadonlyArray<string> => {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    // line comments
    if ((c === "-" && next === "-") || (dialect === "mysql" && c === "#")) {
      while (i < n && sql[i] !== "\n") { buf += sql[i]; i++; }
      continue;
    }
    if (c === "/" && next === "*") {
      buf += "/*"; i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) { buf += sql[i]; i++; }
      buf += "*/"; i += 2;
      continue;
    }
    if (c === "'" || c === '"' || ((dialect === "mysql" || dialect === "bigquery") && c === "`")) {
      const q = c;
      buf += c; i++;
      while (i < n) {
        if (sql[i] === "\\" && dialect !== "postgres") { buf += sql[i]! + (sql[i + 1] ?? ""); i += 2; continue; }
        if (sql[i] === q) {
          if (sql[i + 1] === q) { buf += q + q; i += 2; continue; }
          buf += q; i++; break;
        }
        buf += sql[i]; i++;
      }
      continue;
    }
    if (dialect === "postgres" && c === "$") {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        buf += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      if (buf.trim().length > 0) out.push(buf.trim());
      buf = "";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
};

/** Replace comments and quoted literals/identifiers with spaces. */
export const scrub = (sql: string, dialect: Dialect): string => {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if ((c === "-" && next === "-") || (dialect === "mysql" && c === "#")) {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      i++;
      while (i < n) {
        if (sql[i] === "\\" && dialect !== "postgres") { i += 2; continue; }
        if (sql[i] === q) {
          if (sql[i + 1] === q) { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    if (dialect === "postgres" && c === "$") {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        out += " ";
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
};

const leadingKeyword = (scrubbed: string): string => {
  let i = 0;
  while (i < scrubbed.length && (isSpace(scrubbed[i]!) || scrubbed[i] === "(")) i++;
  const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(scrubbed.slice(i));
  return m ? m[0].toLowerCase() : "";
};

const deniedToken = (scrubbed: string): string | undefined => {
  const re = /[A-Za-z_][A-Za-z_0-9]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scrubbed)) !== null) {
    const t = m[0].toLowerCase();
    if (DENY_TOKENS.has(t)) return t;
  }
  return undefined;
};

/* -------------------------------------------------------------------------- */
/*  AST gate                                                                   */
/* -------------------------------------------------------------------------- */

type Ast = Record<string, unknown> & { type?: string };

const WRITE_TYPES = new Set(["insert", "update", "delete", "replace", "merge", "insert_replace"]);
const DDL_TYPES = new Set([
  "create", "drop", "alter", "truncate", "rename", "grant", "revoke", "comment", "analyze",
]);

/** Walk `with` clauses (and any nested ast) looking for a non-select statement. */
const nestedWriteType = (node: unknown, depth = 0): string | undefined => {
  if (depth > 12 || node === null || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = nestedWriteType(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const obj = node as Ast;
  const t = typeof obj.type === "string" ? obj.type.toLowerCase() : undefined;
  if (t && (WRITE_TYPES.has(t) || DDL_TYPES.has(t))) return t;
  for (const key of ["with", "stmt", "ast", "expr", "_next", "union"]) {
    if (key in obj) {
      const found = nestedWriteType(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
};

const astKind = (ast: Ast): { kind: StatementKind; reason?: string } => {
  const t = typeof ast.type === "string" ? ast.type.toLowerCase() : "";
  if (WRITE_TYPES.has(t)) return { kind: "write", reason: `${t} statement` };
  if (DDL_TYPES.has(t)) return { kind: "ddl", reason: `${t} statement` };
  if (t === "select") {
    if (ast["into"] !== undefined && ast["into"] !== null) {
      const into = ast["into"] as Record<string, unknown>;
      // node-sql-parser sets `into: { position: null }` for a plain select.
      if (into["position"] !== null && into["position"] !== undefined) {
        return { kind: "write", reason: "select … into writes a new relation" };
      }
      if (into["expr"] !== undefined || into["keyword"] !== undefined) {
        return { kind: "write", reason: "select … into writes a new relation" };
      }
    }
    const nested = ast["with"] !== undefined ? nestedWriteType(ast["with"]) : undefined;
    if (nested) return { kind: "write", reason: `CTE contains a ${nested} statement` };
    return { kind: "read" };
  }
  if (t === "show" || t === "desc" || t === "describe" || t === "explain" || t === "values") {
    return { kind: "read" };
  }
  return { kind: "other", reason: t ? `unclassified statement type "${t}"` : "unclassified statement" };
};

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * node-sql-parser bundles every dialect grammar (several MB of JS). Load it on the first
 * classification instead of at sidecar startup; the binding stays synchronous via require().
 */
let parserInstance: SqlParser | undefined;
const getParser = (): SqlParser => {
  if (!parserInstance) {
    const { Parser } = require("node-sql-parser") as typeof import("node-sql-parser");
    parserInstance = new Parser();
  }
  return parserInstance;
};

export const classifyStatements = (sql: string, dialect: Dialect): ReadonlyArray<ClassifiedStatement> => {
  const parser = getParser();
  return splitStatements(sql, dialect).map((stmt): ClassifiedStatement => {
    const scrubbed = scrub(stmt, dialect);
    const lead = leadingKeyword(scrubbed);

    if (!READ_LEADING.has(lead)) {
      // Fast path: definitely not a read.
      const kind: StatementKind =
        lead === "insert" || lead === "update" || lead === "delete" || lead === "replace" || lead === "merge"
          ? "write"
          : lead === "create" || lead === "drop" || lead === "alter" || lead === "truncate" || lead === "rename"
            ? "ddl"
            : "other";
      return { sql: stmt, kind, reason: lead ? `statement begins with "${lead}"` : "empty statement" };
    }

    const denied = deniedToken(scrubbed);
    if (denied !== undefined) {
      return { sql: stmt, kind: "write", reason: `contains the "${denied.toUpperCase()}" keyword` };
    }
    const deniedFn = deniedFunction(scrubbed, dialect);
    if (deniedFn !== undefined) {
      return { sql: stmt, kind: "other", reason: `calls "${deniedFn}()", which has side effects and is not allowed in read-only mode` };
    }

    let ast: unknown;
    try {
      ast = parser.astify(stmt, { database: parserDialect[dialect] });
    } catch (cause) {
      if (INTROSPECTIVE_LEADING.has(lead)) {
        // SHOW/EXPLAIN/DESCRIBE frequently fail to parse but the deny-list
        // above already proved there is no write keyword in the statement.
        return { sql: stmt, kind: "read" };
      }
      const message = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
      return { sql: stmt, kind: "other", reason: `could not parse statement: ${message}` };
    }

    const asts: ReadonlyArray<Ast> = Array.isArray(ast) ? (ast as Array<Ast>) : [ast as Ast];
    if (asts.length === 0) return { sql: stmt, kind: "other", reason: "empty parse result" };
    for (const a of asts) {
      const r = astKind(a);
      if (r.kind !== "read") return { sql: stmt, kind: r.kind, ...(r.reason ? { reason: r.reason } : {}) };
    }
    return { sql: stmt, kind: "read" };
  });
};

/**
 * `true` only when every statement is provably a read. Anything unparsable,
 * unknown or containing a write keyword yields `false` plus a `reason`.
 */
export const isReadOnlySql = (sql: string, dialect: Dialect): ReadOnlyVerdict => {
  const statements = classifyStatements(sql, dialect);
  if (statements.length === 0) {
    return { readOnly: false, statements: 0, reason: "no statement found" };
  }
  const offender = statements.find((s) => s.kind !== "read");
  if (offender) {
    return {
      readOnly: false,
      statements: statements.length,
      reason: offender.reason ?? `${offender.kind} statement is not permitted here`,
    };
  }
  return { readOnly: true, statements: statements.length };
};

/**
 * Guard for `Driver.explain`. EXPLAIN without ANALYZE never executes the
 * statement, so a single DML statement is fine to plan — but the text is
 * concatenated after `EXPLAIN …`, so two things must be ruled out:
 *  - more than one statement (`SELECT 1; DELETE …` would run the DELETE), and
 *  - a leading `ANALYZE` (`EXPLAIN ANALYZE …` executes, in MySQL too).
 * Returns a reason when the text must not be explained.
 */
export const explainGuard = (sql: string, dialect: Dialect): string | undefined => {
  const statements = splitStatements(sql, dialect);
  if (statements.length === 0) return "no statement found";
  if (statements.length > 1) return "only one statement can be explained at a time";
  const lead = leadingKeyword(scrub(statements[0]!, dialect));
  if (lead === "analyze" || lead === "analyse") return "EXPLAIN ANALYZE executes the statement and is not allowed here";
  if (lead === "explain") return "nested EXPLAIN is not allowed";
  if (lead === "") return "empty statement";
  return undefined;
};
