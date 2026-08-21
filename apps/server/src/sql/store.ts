/**
 * `query_history` + `saved_queries` access for the `sql.*` handlers
 * (migration 0001). Built from a `SqlClient` so it can be exercised against an
 * in-memory / temp-dir sqlite in tests.
 */
import type {
  ConnectionId,
  QueryHistoryEntry,
  QueryId,
  SavedQuery,
  SavedQuerySaveInput,
} from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError as SqlStorageError } from "effect/unstable/sql/SqlError";

/** Most recent N history rows returned by `sql.history.list`. */
export const HISTORY_LIMIT = 200;
/** Rows kept per connection in `query_history`; older ones are pruned on insert. */
export const HISTORY_RETAIN = 1_000;

export interface HistoryInsert {
  readonly connectionId: ConnectionId;
  readonly sql: string;
  readonly durationMs: number;
  readonly rowCount: number;
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly ranAt: string;
}

interface HistoryRow {
  readonly id: string;
  readonly connection_id: string;
  readonly sql: string;
  readonly duration_ms: number;
  readonly row_count: number;
  readonly ok: number | boolean;
  readonly error: string | null;
  readonly ran_at: string;
}

interface SavedRow {
  readonly id: string;
  readonly connection_id: string;
  readonly name: string;
  readonly sql: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SqlStore {
  readonly recordRun: (entry: HistoryInsert) => Effect.Effect<void, SqlStorageError>;
  readonly listHistory: (
    connectionId: ConnectionId,
  ) => Effect.Effect<ReadonlyArray<QueryHistoryEntry>, SqlStorageError>;
  readonly listSaved: (connectionId: ConnectionId) => Effect.Effect<ReadonlyArray<SavedQuery>, SqlStorageError>;
  readonly saveQuery: (input: SavedQuerySaveInput) => Effect.Effect<SavedQuery, SqlStorageError>;
  readonly deleteQuery: (id: QueryId) => Effect.Effect<boolean, SqlStorageError>;
}

const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const toHistoryEntry = (row: HistoryRow): QueryHistoryEntry => ({
  id: row.id,
  connectionId: row.connection_id as ConnectionId,
  sql: row.sql,
  durationMs: row.duration_ms,
  rowCount: row.row_count,
  ok: Boolean(row.ok),
  // `error` is `Schema.optional(String)`; `null` would fail encoding.
  ...(row.error === null ? {} : { error: row.error }),
  ranAt: row.ran_at,
});

const toSavedQuery = (row: SavedRow): SavedQuery => ({
  id: row.id as QueryId,
  connectionId: row.connection_id as ConnectionId,
  name: row.name,
  sql: row.sql,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const makeSqlStore = (sql: SqlClient.SqlClient): SqlStore => ({
  recordRun: (entry) =>
    sql`
      INSERT INTO query_history (id, connection_id, sql, duration_ms, row_count, ok, error, ran_at)
      VALUES (
        ${newId("h")},
        ${entry.connectionId},
        ${entry.sql},
        ${Math.round(entry.durationMs)},
        ${Math.round(entry.rowCount)},
        ${entry.ok ? 1 : 0},
        ${entry.error ?? null},
        ${entry.ranAt}
      )
    `.pipe(
      Effect.andThen(
        sql`
          DELETE FROM query_history
          WHERE connection_id = ${entry.connectionId}
            AND rowid NOT IN (
              SELECT rowid FROM query_history
              WHERE connection_id = ${entry.connectionId}
              ORDER BY ran_at DESC, rowid DESC
              LIMIT ${HISTORY_RETAIN}
            )
        `,
      ),
      Effect.asVoid,
    ),

  listHistory: (connectionId) =>
    sql<HistoryRow>`
      SELECT id, connection_id, sql, duration_ms, row_count, ok, error, ran_at
      FROM query_history
      WHERE connection_id = ${connectionId}
      ORDER BY ran_at DESC, rowid DESC
      LIMIT ${HISTORY_LIMIT}
    `.pipe(Effect.map((rows) => rows.map(toHistoryEntry))),

  listSaved: (connectionId) =>
    sql<SavedRow>`
      SELECT id, connection_id, name, sql, created_at, updated_at
      FROM saved_queries
      WHERE connection_id = ${connectionId}
      ORDER BY updated_at DESC, rowid DESC
    `.pipe(Effect.map((rows) => rows.map(toSavedQuery))),

  saveQuery: (input) =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const id = input.id ?? (newId("q") as QueryId);
      const existing = yield* sql<{ created_at: string }>`
        SELECT created_at FROM saved_queries WHERE id = ${id}
      `;
      const prior = existing[0];
      if (prior) {
        yield* sql`
          UPDATE saved_queries
          SET name = ${input.name}, sql = ${input.sql}, connection_id = ${input.connectionId}, updated_at = ${now}
          WHERE id = ${id}
        `;
        return {
          id,
          connectionId: input.connectionId,
          name: input.name,
          sql: input.sql,
          createdAt: prior.created_at,
          updatedAt: now,
        } satisfies SavedQuery;
      }
      yield* sql`
        INSERT INTO saved_queries (id, connection_id, name, sql, created_at, updated_at)
        VALUES (${id}, ${input.connectionId}, ${input.name}, ${input.sql}, ${now}, ${now})
      `;
      return {
        id,
        connectionId: input.connectionId,
        name: input.name,
        sql: input.sql,
        createdAt: now,
        updatedAt: now,
      } satisfies SavedQuery;
    }),

  /** Returns `false` when nothing matched, so the handler can raise `NotFound`. */
  deleteQuery: (id) =>
    Effect.gen(function* () {
      const existing = yield* sql<{ id: string }>`SELECT id FROM saved_queries WHERE id = ${id}`;
      if (existing.length === 0) return false;
      yield* sql`DELETE FROM saved_queries WHERE id = ${id}`;
      return true;
    }),
});
