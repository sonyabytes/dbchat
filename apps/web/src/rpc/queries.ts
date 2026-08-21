import { type ConnectionId, RPC } from "@dbchat/contracts";
import { queryOptions } from "@tanstack/react-query";

import { callRpc } from "./client";

export const serverHealthQuery = queryOptions({
  queryKey: ["server.health"],
  queryFn: () => callRpc((c) => c[RPC.serverHealth]()),
  staleTime: 30_000,
});

export const connectionListQuery = queryOptions({
  queryKey: ["connection.list"],
  queryFn: () => callRpc((c) => c[RPC.connectionList]()),
});

export const schemaListQuery = (connectionId: ConnectionId) =>
  queryOptions({
    queryKey: ["schema.list", connectionId],
    queryFn: () => callRpc((c) => c[RPC.schemaList]({ connectionId })),
  });

export const schemaTableQuery = (connectionId: ConnectionId, schema: string, table: string) =>
  queryOptions({
    queryKey: ["schema.table", connectionId, schema, table],
    queryFn: () => callRpc((c) => c[RPC.schemaTable]({ connectionId, schema, table })),
    staleTime: 5 * 60_000,
    retry: false,
  });

/** Force the server to re-introspect; callers invalidate `schema.list` / `schema.table` afterwards. */
export const refreshSchema = (connectionId: ConnectionId) =>
  callRpc((c) => c[RPC.schemaRefresh]({ connectionId }));

/* ---------------- error rendering ---------------- */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Unwrap the layers Effect/react-query can put around a tagged error. */
function unwrap(error: unknown, depth = 0): unknown {
  if (depth > 4 || !isRecord(error)) return error;
  if (typeof error["_tag"] === "string" && error["_tag"] !== "Fail" && error["_tag"] !== "Die") return error;
  for (const key of ["error", "failure", "cause", "defect"]) {
    if (key in error && error[key] !== undefined && error[key] !== error) return unwrap(error[key], depth + 1);
  }
  return error;
}

/** Human message for a tagged RPC error (SqlError / DriverError / ConnectionError / NotFound / …). */
export function rpcErrorMessage(error: unknown): string {
  const e = unwrap(error);
  if (typeof e === "string") return e;
  if (!isRecord(e)) return "Unknown error";
  const tag = typeof e["_tag"] === "string" ? (e["_tag"] as string) : undefined;
  if (tag === "NotFound") return `${String(e["entity"] ?? "record")} “${String(e["id"] ?? "")}” not found`;
  if (tag === "WriteBlocked") return `Write blocked: ${String(e["reason"] ?? "read-only connection")}`;
  const message = typeof e["message"] === "string" && e["message"] ? (e["message"] as string) : undefined;
  if (message) return message;
  return tag ?? "Unknown error";
}

/** Short label for the error banner heading. */
export function rpcErrorTag(error: unknown): string {
  const e = unwrap(error);
  const tag = isRecord(e) && typeof e["_tag"] === "string" ? (e["_tag"] as string) : undefined;
  switch (tag) {
    case "SqlError": return "SQL error";
    case "DriverError": return "Driver error";
    case "ConnectionError": return "Connection error";
    case "ValidationError": return "Invalid input";
    case "NotFound": return "Not found";
    case "WriteBlocked": return "Write blocked";
    default: return "Error";
  }
}
