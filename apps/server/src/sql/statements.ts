/**
 * Pure, dependency-free SQL text helpers used by the `sql.*` handlers.
 *
 * Everything here is deliberately side-effect free so it can be unit tested
 * without a driver, a database, or an Effect runtime.
 */
import type { ConnectionId, RunId } from "@dbchat/contracts";

const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Splits a SQL string into top-level statements on `;`, ignoring semicolons
 * that appear inside string literals, quoted identifiers, comments, or
 * Postgres dollar-quoted bodies.
 *
 * Trailing/blank statements are dropped, so `"select 1;"` yields one statement.
 */
export const splitStatements = (input: string): ReadonlyArray<string> => {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = input.length;

  const push = (end: number) => {
    const chunk = input.slice(start, end).trim();
    if (chunk.length > 0) out.push(chunk);
  };

  while (i < n) {
    const c = input[i]!;

    // -- line comment
    if (c === "-" && input[i + 1] === "-") {
      const nl = input.indexOf("\n", i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    // # line comment (MySQL)
    if (c === "#") {
      const nl = input.indexOf("\n", i + 1);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    // block comment (not nested - close enough to Postgres/MySQL for a guard)
    if (c === "/" && input[i + 1] === "*") {
      const end = input.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // '...' / "..." / `...`
    if (c === "'" || c === '"' || c === "`") {
      i += 1;
      while (i < n) {
        const q = input[i]!;
        if (q === "\\") {
          // backslash escapes (MySQL, and Postgres E'' strings)
          i += 2;
          continue;
        }
        if (q === c) {
          // a doubled quote is an escaped quote, not a terminator
          if (input[i + 1] === c) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    // dollar-quoted body (Postgres)
    if (c === "$") {
      const tag = DOLLAR_TAG.exec(input.slice(i));
      if (tag) {
        const marker = tag[0];
        const end = input.indexOf(marker, i + marker.length);
        i = end === -1 ? n : end + marker.length;
        continue;
      }
    }
    if (c === ";") {
      push(i);
      start = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  push(n);
  return out;
};

/** True when the text contains more than one executable statement. */
export const isMultiStatement = (input: string): boolean => splitStatements(input).length > 1;

/** Offset of the first real token, skipping whitespace, comments and open parens. */
const firstTokenOffset = (input: string): number => {
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") {
      i += 1;
      continue;
    }
    if (c === "-" && input[i + 1] === "-") {
      const nl = input.indexOf("\n", i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === "/" && input[i + 1] === "*") {
      const end = input.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "(") {
      i += 1;
      continue;
    }
    break;
  }
  return i;
};

/**
 * The command keyword of a statement (`SELECT`, `INSERT`, `WITH`, ...), used
 * for `SqlResult.command`. Leading comments and wrapping parens are skipped.
 * Returns `undefined` when there is no identifier to report.
 */
export const detectCommand = (input: string): string | undefined => {
  const rest = input.slice(firstTokenOffset(input));
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
  return m ? m[0].toUpperCase() : undefined;
};

/** FNV-1a 32-bit, rendered as 8 lowercase hex chars. Stable across processes. */
export const hashSql = (input: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

/**
 * `SqlRunRequest.runId` is optional in the contract but `sql.cancel` requires
 * one, so when the client omits it we derive a deterministic id from the
 * connection plus the SQL text:
 *
 *     runId = `${connectionId}:${fnv1a(sql)}`
 *
 * Two identical statements on the same connection therefore share a runId;
 * `sql.cancel` interrupts the most recent run registered under it.
 */
export const deriveRunId = (connectionId: ConnectionId, sql: string): RunId =>
  `${connectionId}:${hashSql(sql)}` as RunId;
