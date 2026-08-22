import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Remote-backed Git sources: origin/remote metadata, sync status, and encrypted tokens. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE git_repositories ADD COLUMN origin TEXT NOT NULL DEFAULT 'local' CHECK(origin IN ('local', 'github'))`;
  yield* sql`ALTER TABLE git_repositories ADD COLUMN remote_url TEXT`;
  yield* sql`ALTER TABLE git_repositories ADD COLUMN status TEXT NOT NULL DEFAULT 'connected'`;
  yield* sql`ALTER TABLE git_repositories ADD COLUMN status_message TEXT`;
  yield* sql`ALTER TABLE git_repositories ADD COLUMN last_fetched_at TEXT`;

  // Same AES-GCM envelope as connection_secrets; the token lives in the `password` slot.
  yield* sql`
    CREATE TABLE IF NOT EXISTS git_repository_secrets (
      repository_id TEXT PRIMARY KEY REFERENCES git_repositories(id) ON DELETE CASCADE,
      secret TEXT NOT NULL,
      nonce TEXT NOT NULL
    )
  `;
});
