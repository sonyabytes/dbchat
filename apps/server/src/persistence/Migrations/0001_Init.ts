import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      dialect TEXT NOT NULL,
      host TEXT NOT NULL DEFAULT '',
      port INTEGER NOT NULL DEFAULT 0,
      database TEXT NOT NULL DEFAULT '',
      user TEXT NOT NULL DEFAULT '',
      env TEXT NOT NULL DEFAULT 'local',
      ssl TEXT NOT NULL DEFAULT 'prefer',
      read_only_for_ai INTEGER NOT NULL DEFAULT 1,
      color TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      last_used_at TEXT
    )
  `;

  // Secrets (password / full URL) live apart from metadata; `secret` is an
  // AES-GCM encrypted blob, `nonce` its IV. Key management lives in the Layer.
  yield* sql`
    CREATE TABLE IF NOT EXISTS connection_secrets (
      connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
      secret BLOB NOT NULL,
      nonce BLOB NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      sdk_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_threads_connection ON threads(connection_id, updated_at DESC)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      parts_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS query_history (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      sql TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      error TEXT,
      ran_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_history_connection ON query_history(connection_id, ran_at DESC)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS saved_queries (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sql TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      message_id TEXT,
      sql TEXT NOT NULL,
      row_estimate INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      result_json TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;
});
