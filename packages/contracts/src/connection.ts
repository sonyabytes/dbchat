import * as Schema from "effect/Schema";
import { ConnectionId, IsoDateTime } from "./ids.ts";

export const Dialect = Schema.Literals(["postgres", "mysql", "sqlite"]);
export type Dialect = typeof Dialect.Type;

export const ConnectionEnv = Schema.Literals(["local", "staging", "prod"]);
export type ConnectionEnv = typeof ConnectionEnv.Type;

export const SslMode = Schema.Literals(["disable", "prefer", "require"]);
export type SslMode = typeof SslMode.Type;

export const Connection = Schema.Struct({
  id: ConnectionId,
  name: Schema.String,
  dialect: Dialect,
  host: Schema.String,
  port: Schema.Number,
  database: Schema.String,
  user: Schema.String,
  env: ConnectionEnv,
  ssl: SslMode,
  readOnlyForAi: Schema.Boolean,
  color: Schema.String,
  createdAt: IsoDateTime,
  lastUsedAt: Schema.optional(IsoDateTime),
});
export type Connection = typeof Connection.Type;

/** Input for create/update/test. Either fill the fields or pass a `url`. */
export const ConnectionInput = Schema.Struct({
  name: Schema.String,
  dialect: Dialect,
  host: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  database: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  password: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  env: ConnectionEnv,
  ssl: SslMode,
  readOnlyForAi: Schema.Boolean,
  color: Schema.optional(Schema.String),
});
export type ConnectionInput = typeof ConnectionInput.Type;

export const ConnectionState = Schema.Literals(["connected", "idle", "error"]);
export type ConnectionState = typeof ConnectionState.Type;

export const ConnectionStatus = Schema.Struct({
  id: ConnectionId,
  state: ConnectionState,
  latencyMs: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
});
export type ConnectionStatus = typeof ConnectionStatus.Type;

export const ConnectionTestResult = Schema.Struct({
  ok: Schema.Boolean,
  latencyMs: Schema.Number,
  serverVersion: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type ConnectionTestResult = typeof ConnectionTestResult.Type;
