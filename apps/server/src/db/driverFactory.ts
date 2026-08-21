/**
 * Builds a `Driver` from stored metadata + its decrypted secret, or straight
 * from a `ConnectionInput` (the connection-test path). A `url` always wins over
 * the individual fields.
 */
import type { Connection, ConnectionInput, Dialect, SslMode } from "@dbchat/contracts";
import type { ConnectionError } from "@dbchat/contracts";
import type * as Effect from "effect/Effect";

import type { ConnectionSecret } from "../Services/ConnectionStore.ts";
import type { Driver } from "../Services/DriverRegistry.ts";
import { makeMysqlDriver } from "./mysql.ts";
import { makePostgresDriver } from "./postgres.ts";
import { makeSqliteDriver } from "./sqlite.ts";

export interface DriverSpec {
  readonly dialect: Dialect;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly database?: string | undefined;
  readonly user?: string | undefined;
  readonly password?: string | undefined;
  readonly url?: string | undefined;
  readonly ssl?: SslMode | undefined;
}

const nonEmpty = (s: string | undefined): string | undefined =>
  s !== undefined && s.trim().length > 0 ? s : undefined;

export const specFromConnection = (
  connection: Connection,
  secret: ConnectionSecret | undefined,
): DriverSpec => ({
  dialect: connection.dialect,
  host: nonEmpty(connection.host),
  port: connection.port > 0 ? connection.port : undefined,
  database: nonEmpty(connection.database),
  user: nonEmpty(connection.user),
  password: nonEmpty(secret?.password),
  url: nonEmpty(secret?.url),
  ssl: connection.ssl,
});

export const specFromInput = (input: ConnectionInput): DriverSpec => ({
  dialect: input.dialect,
  host: nonEmpty(input.host),
  port: input.port !== undefined && input.port > 0 ? input.port : undefined,
  database: nonEmpty(input.database),
  user: nonEmpty(input.user),
  password: nonEmpty(input.password),
  url: nonEmpty(input.url),
  ssl: input.ssl,
});

/** For sqlite the "url" may be a `sqlite:` / `file:` URL or a bare path. */
const sqliteFilename = (spec: DriverSpec): string => {
  const url = spec.url;
  if (url !== undefined) {
    const stripped = url.replace(/^sqlite:(\/\/)?/i, "").replace(/^file:(\/\/)?/i, "");
    if (stripped.length > 0) return stripped;
  }
  return spec.database ?? ":memory:";
};

export const makeDriverFromSpec = (spec: DriverSpec): Effect.Effect<Driver, ConnectionError> => {
  switch (spec.dialect) {
    case "postgres":
      return makePostgresDriver({
        url: spec.url,
        host: spec.host,
        port: spec.port,
        database: spec.database,
        user: spec.user,
        password: spec.password,
        ssl: spec.ssl,
      });
    case "mysql":
      return makeMysqlDriver({
        url: spec.url,
        host: spec.host,
        port: spec.port,
        database: spec.database,
        user: spec.user,
        password: spec.password,
        ssl: spec.ssl,
      });
    case "sqlite":
      return makeSqliteDriver({ filename: sqliteFilename(spec) });
  }
};

export const makeDriver = (
  connection: Connection,
  secret: ConnectionSecret | undefined,
): Effect.Effect<Driver, ConnectionError> => makeDriverFromSpec(specFromConnection(connection, secret));
