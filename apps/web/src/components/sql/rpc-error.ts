/** Pull a tagged contract error (SqlError, WriteBlocked, …) out of whatever the RPC runtime rejects with. */
export interface RpcErrorInfo {
  tag?: string;
  message: string;
  position?: number;
  reason?: string;
  sql?: string;
}

const TAGS = new Set([
  "SqlError",
  "WriteBlocked",
  "ConnectionError",
  "DriverError",
  "NotFound",
  "AgentError",
  "ValidationError",
]);

function find(e: unknown, depth = 0): Record<string, unknown> | null {
  if (!e || typeof e !== "object" || depth > 6) return null;
  const o = e as Record<string, unknown>;
  if (typeof o._tag === "string" && TAGS.has(o._tag)) return o;
  for (const key of ["error", "cause", "defect", "value"]) {
    const hit = find(o[key], depth + 1);
    if (hit) return hit;
  }
  if (Array.isArray(o.failures)) {
    for (const f of o.failures) {
      const hit = find(f, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function describeRpcError(e: unknown): RpcErrorInfo {
  const tagged = find(e);
  if (tagged) {
    const info: RpcErrorInfo = {
      tag: tagged._tag as string,
      message:
        (typeof tagged.message === "string" && tagged.message) ||
        (typeof tagged.reason === "string" && tagged.reason) ||
        (tagged._tag === "NotFound" ? `${String(tagged.entity)} not found` : String(tagged._tag)),
    };
    if (typeof tagged.position === "number") info.position = tagged.position;
    if (typeof tagged.reason === "string") info.reason = tagged.reason;
    if (typeof tagged.sql === "string") info.sql = tagged.sql;
    return info;
  }
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return { message: (e as { message: string }).message };
  }
  return { message: typeof e === "string" ? e : "Request failed" };
}

/** 1-based line/column for a byte position inside the statement. */
export function positionToLine(sql: string, position: number): { line: number; column: number } {
  const upto = sql.slice(0, Math.max(0, position - 1));
  const lines = upto.split("\n");
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}
