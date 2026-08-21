/**
 * sqlite-backed ConnectionStore.
 *
 * Metadata lives in `connections`; passwords / URLs live encrypted in
 * `connection_secrets` (see `db/secrets.ts`). `Connection` values handed back
 * to callers never contain a secret.
 */
import {
  type Connection,
  type ConnectionId,
  type ConnectionInput,
  NotFound,
  type ValidationError,
} from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SecretCipher, SecretCipherLive } from "../db/secrets.ts";
import { DEFAULT_PORT, validateConnectionInput } from "../db/validate.ts";
import { Persistence } from "../persistence/Persistence.ts";
import { type ConnectionSecret, ConnectionStore } from "../Services/ConnectionStore.ts";

const DEFAULT_COLOR = "oklch(62.6% 0.205 254.947)";

interface ConnectionRow {
  id: string;
  name: string;
  dialect: string;
  host: string;
  port: number;
  database: string;
  user: string;
  env: string;
  ssl: string;
  read_only_for_ai: number;
  color: string;
  created_at: string;
  last_used_at: string | null;
}

const asDialect = (s: string): Connection["dialect"] =>
  s === "mysql" ? "mysql" : s === "sqlite" ? "sqlite" : "postgres";
const asEnv = (s: string): Connection["env"] => (s === "prod" ? "prod" : s === "staging" ? "staging" : "local");
const asSsl = (s: string): Connection["ssl"] => (s === "disable" ? "disable" : s === "require" ? "require" : "prefer");

const toConnection = (row: ConnectionRow): Connection => ({
  id: row.id as ConnectionId,
  name: row.name,
  dialect: asDialect(row.dialect),
  host: row.host,
  port: Number(row.port) || 0,
  database: row.database,
  user: row.user,
  env: asEnv(row.env),
  ssl: asSsl(row.ssl),
  readOnlyForAi: row.read_only_for_ai !== 0,
  color: row.color.length > 0 ? row.color : DEFAULT_COLOR,
  createdAt: row.created_at,
  ...(row.last_used_at !== null ? { lastUsedAt: row.last_used_at } : {}),
});

const newId = (): ConnectionId =>
  `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` as ConnectionId;

const secretFrom = (input: ConnectionInput): ConnectionSecret | undefined => {
  const password = input.password !== undefined && input.password.length > 0 ? input.password : undefined;
  const url = input.url !== undefined && input.url.length > 0 ? input.url : undefined;
  if (password === undefined && url === undefined) return undefined;
  return { ...(password !== undefined ? { password } : {}), ...(url !== undefined ? { url } : {}) };
};

export const ConnectionStoreLive = Layer.effect(
  ConnectionStore,
  Effect.gen(function* () {
    const { sql } = yield* Persistence;
    const cipher = yield* SecretCipher;

    /** The store's contract has no SQL error channel; a broken app DB is fatal. */
    const die = <A, E>(self: Effect.Effect<A, E>) => Effect.orDie(self);

    const selectById = (id: ConnectionId) =>
      die(sql<ConnectionRow>`SELECT * FROM connections WHERE id = ${id}`);

    const get = (id: ConnectionId) =>
      selectById(id).pipe(
        Effect.flatMap((rows) =>
          rows[0] ? Effect.succeed(toConnection(rows[0])) : Effect.fail(new NotFound({ entity: "connection", id })),
        ),
      );

    const writeSecret = (id: ConnectionId, secret: ConnectionSecret) =>
      Effect.gen(function* () {
        const enc = cipher.encrypt(secret);
        const now = new Date().toISOString();
        yield* sql`
          INSERT INTO connection_secrets (connection_id, secret, nonce, updated_at)
          VALUES (${id}, ${enc.secret}, ${enc.nonce}, ${now})
          ON CONFLICT(connection_id) DO UPDATE SET
            secret = excluded.secret, nonce = excluded.nonce, updated_at = excluded.updated_at
        `;
      }).pipe(die);

    const row = (input: ConnectionInput) => ({
      name: input.name.trim(),
      dialect: input.dialect,
      host: input.host ?? "",
      port: input.port ?? DEFAULT_PORT[input.dialect],
      database: input.database ?? "",
      user: input.user ?? "",
      env: input.env,
      ssl: input.ssl,
      readOnly: input.readOnlyForAi ? 1 : 0,
      color: input.color ?? DEFAULT_COLOR,
    });

    const create = (input: ConnectionInput): Effect.Effect<Connection, ValidationError> =>
      Effect.gen(function* () {
        const problem = validateConnectionInput(input);
        if (problem) return yield* Effect.fail(problem);
        const id = newId();
        const now = new Date().toISOString();
        const r = row(input);
        yield* die(sql`
          INSERT INTO connections
            (id, name, dialect, host, port, "database", "user", env, ssl, read_only_for_ai, color, created_at, last_used_at)
          VALUES
            (${id}, ${r.name}, ${r.dialect}, ${r.host}, ${r.port}, ${r.database}, ${r.user},
             ${r.env}, ${r.ssl}, ${r.readOnly}, ${r.color}, ${now}, ${null})
        `);
        const secret = secretFrom(input);
        if (secret) yield* writeSecret(id, secret);
        return yield* get(id).pipe(Effect.orDie);
      });

    const update = (id: ConnectionId, input: ConnectionInput) =>
      Effect.gen(function* () {
        const problem = validateConnectionInput(input);
        if (problem) return yield* Effect.fail(problem);
        const previous = yield* get(id);
        const r = row(input);
        yield* die(sql`
          UPDATE connections SET
            name = ${r.name},
            dialect = ${r.dialect},
            host = ${input.host ?? previous.host},
            port = ${input.port ?? previous.port},
            "database" = ${input.database ?? previous.database},
            "user" = ${input.user ?? previous.user},
            env = ${r.env},
            ssl = ${r.ssl},
            read_only_for_ai = ${r.readOnly},
            color = ${input.color ?? previous.color}
          WHERE id = ${id}
        `);
        // Only replace the stored secret when the caller actually sent one, so
        // editing a connection does not require retyping the password.
        const secret = secretFrom(input);
        if (secret) yield* writeSecret(id, secret);
        return yield* get(id).pipe(Effect.orDie);
      });

    const remove = (id: ConnectionId) =>
      get(id).pipe(
        Effect.flatMap(() =>
          die(
            Effect.all([
              sql`DELETE FROM connection_secrets WHERE connection_id = ${id}`,
              sql`DELETE FROM connections WHERE id = ${id}`,
            ]),
          ),
        ),
        Effect.asVoid,
      );

    const getSecret = (id: ConnectionId): Effect.Effect<Option.Option<ConnectionSecret>> =>
      die(sql<{ secret: string; nonce: string }>`
        SELECT secret, nonce FROM connection_secrets WHERE connection_id = ${id}
      `).pipe(
        Effect.flatMap((rows) => {
          const found = rows[0];
          if (!found) return Effect.succeed(Option.none<ConnectionSecret>());
          return Effect.try(() =>
            Option.some(cipher.decrypt({ secret: String(found.secret), nonce: String(found.nonce) })),
          ).pipe(
            Effect.catch((e) =>
              Effect.logWarning("could not decrypt connection secret", { id, message: String(e) }).pipe(
                Effect.as(Option.none<ConnectionSecret>()),
              ),
            ),
          );
        }),
      );

    return ConnectionStore.of({
      list: die(sql<ConnectionRow>`SELECT * FROM connections ORDER BY created_at DESC`).pipe(
        Effect.map((rows) => rows.map(toConnection)),
      ),
      get,
      getSecret,
      create,
      update,
      remove,
      touch: (id) =>
        die(sql`UPDATE connections SET last_used_at = ${new Date().toISOString()} WHERE id = ${id}`).pipe(
          Effect.asVoid,
        ),
    });
  }),
).pipe(Layer.provide(SecretCipherLive));
