import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Remembers the model a thread last ran on, so reopening a chat reopens the
 * picker on the same model. NULL = "use the server default".
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE threads ADD COLUMN model TEXT`;
});
