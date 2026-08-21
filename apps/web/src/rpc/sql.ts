/** sql.* RPC helpers for the SQL editor. */
import {
  type ConnectionId,
  type QueryId,
  RPC,
  type RunId,
  type SqlResult,
  type SqlSuggestResult,
} from "@dbchat/contracts";
import { queryOptions } from "@tanstack/react-query";

import { callRpc } from "./client";

export const historyKey = (connectionId: string) => ["sql.history.list", connectionId] as const;
export const savedKey = (connectionId: string) => ["sql.saved.list", connectionId] as const;

export const historyQuery = (connectionId: string) =>
  queryOptions({
    queryKey: historyKey(connectionId),
    queryFn: () => callRpc((c) => c[RPC.sqlHistoryList]({ connectionId: connectionId as ConnectionId })),
    enabled: Boolean(connectionId),
  });

export const savedQueriesQuery = (connectionId: string) =>
  queryOptions({
    queryKey: savedKey(connectionId),
    queryFn: () => callRpc((c) => c[RPC.sqlSavedList]({ connectionId: connectionId as ConnectionId })),
    enabled: Boolean(connectionId),
  });

/** Column detail for one table — same key shape the schema tree uses, so the cache is shared. */
export const tableDetailQuery = (connectionId: string, schema: string, table: string) =>
  queryOptions({
    queryKey: ["schema.table", connectionId, schema, table] as const,
    queryFn: () =>
      callRpc((c) => c[RPC.schemaTable]({ connectionId: connectionId as ConnectionId, schema, table })),
    staleTime: 5 * 60_000,
    enabled: Boolean(connectionId && table),
  });

export const runSql = (input: {
  connectionId: string;
  sql: string;
  limit?: number;
  readOnly?: boolean;
  runId?: string;
}): Promise<SqlResult> =>
  callRpc((c) =>
    c[RPC.sqlRun]({
      connectionId: input.connectionId as ConnectionId,
      sql: input.sql,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.readOnly === undefined ? {} : { readOnly: input.readOnly }),
      ...(input.runId === undefined ? {} : { runId: input.runId as RunId }),
    }),
  );

export const cancelSql = (runId: string) => callRpc((c) => c[RPC.sqlCancel]({ runId: runId as RunId }));

export const explainSql = (input: { connectionId: string; sql: string; readOnly?: boolean }) =>
  callRpc((c) =>
    c[RPC.sqlExplain]({
      connectionId: input.connectionId as ConnectionId,
      sql: input.sql,
      ...(input.readOnly === undefined ? {} : { readOnly: input.readOnly }),
    }),
  );

export const saveQuery = (input: { id?: string; connectionId: string; name: string; sql: string }) =>
  callRpc((c) =>
    c[RPC.sqlSavedSave]({
      ...(input.id ? { id: input.id as QueryId } : {}),
      connectionId: input.connectionId as ConnectionId,
      name: input.name,
      sql: input.sql,
    }),
  );

export const deleteSavedQuery = (id: string) => callRpc((c) => c[RPC.sqlSavedDelete]({ id: id as QueryId }));

export const suggestSql = (input: { connectionId: string; sql: string; cursor: number }): Promise<SqlSuggestResult> =>
  callRpc((c) =>
    c[RPC.sqlSuggest]({ connectionId: input.connectionId as ConnectionId, sql: input.sql, cursor: input.cursor }),
  );
