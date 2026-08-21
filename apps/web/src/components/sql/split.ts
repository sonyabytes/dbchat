/** Statement splitting: `;` separators that are outside strings, identifiers, comments and $$ blocks. */
export interface Statement {
  from: number;
  to: number;
  text: string;
}

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);

export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  const n = sql.length;
  let start = 0;
  let i = 0;

  const push = (from: number, to: number) => {
    const raw = sql.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim().replace(/;+$/, "").trim();
    if (!trimmed) return;
    out.push({ from: from + lead, to: from + lead + raw.trim().length, text: trimmed });
  };

  while (i < n) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const q = ch;
      i += 1;
      while (i < n) {
        if (sql[i] === "\\" && q === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
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
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
          continue;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
          continue;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "$") {
      let j = i + 1;
      while (j < n && (isIdentStart(sql[j]!) || /\d/.test(sql[j]!))) j += 1;
      if (sql[j] === "$") {
        const tag = sql.slice(i, j + 1);
        const end = sql.indexOf(tag, j + 1);
        i = end < 0 ? n : end + tag.length;
        continue;
      }
    }
    if (ch === ";") {
      push(start, i + 1);
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  push(start, n);
  return out;
}

/** The statement the cursor sits in (or the closest one before it). */
export function statementAt(sql: string, cursor: number): Statement | null {
  const stmts = splitStatements(sql);
  if (stmts.length === 0) return null;
  for (const s of stmts) if (cursor >= s.from && cursor <= s.to + 1) return s;
  let best: Statement | null = null;
  for (const s of stmts) if (s.from <= cursor) best = s;
  return best ?? stmts[0] ?? null;
}

/** What ⌘↵ should run: the selection, else the statement under the cursor, else the buffer. */
export function sqlToRun(doc: string, selFrom: number, selTo: number): string {
  if (selFrom !== selTo) return doc.slice(selFrom, selTo).trim();
  return statementAt(doc, selFrom)?.text ?? doc.trim();
}
