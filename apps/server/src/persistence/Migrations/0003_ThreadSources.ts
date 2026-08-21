import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Decouple conversations from a single database and add read-only Git sources. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS git_repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      branch TEXT NOT NULL,
      head_commit TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_sources (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('database', 'git')),
      source_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (thread_id, source_kind, source_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_thread_sources_thread ON thread_sources(thread_id, position)`;
  yield* sql`INSERT OR IGNORE INTO thread_sources (thread_id, source_kind, source_id, position)
    SELECT id, 'database', connection_id, 0 FROM threads`;

  // SQLite supports dropping this constrained column directly once its index is gone.
  // Messages and approvals keep their foreign key to the threads table intact.
  yield* sql`DROP INDEX IF EXISTS idx_threads_connection`;
  yield* sql`ALTER TABLE threads DROP COLUMN connection_id`;
  yield* sql`ALTER TABLE approvals ADD COLUMN connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL`;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS cleanup_deleted_connection_source
    AFTER DELETE ON connections
    BEGIN
      DELETE FROM thread_sources WHERE source_kind = 'database' AND source_id = OLD.id;
    END
  `;
});
