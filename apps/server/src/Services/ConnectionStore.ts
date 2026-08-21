import type { Connection, ConnectionId, ConnectionInput, NotFound, ValidationError } from "@dbchat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

/** Resolved secret for a connection: password and/or URL (never sent to the client). */
export interface ConnectionSecret {
  readonly password?: string;
  readonly url?: string;
}

/**
 * Apply the secret semantics used by connection edits:
 * - an omitted URL keeps the stored URL;
 * - an explicitly blank URL clears it (switching to individual fields);
 * - a blank/omitted password keeps the stored password.
 */
export const mergeConnectionSecret = (
  input: ConnectionInput,
  previous: ConnectionSecret | undefined,
): ConnectionInput => {
  const { password: inputPassword, url: inputUrl, ...metadata } = input;
  const password = inputPassword !== undefined && inputPassword.trim().length > 0
    ? inputPassword
    : previous?.password;
  const url = inputUrl === undefined
    ? previous?.url
    : inputUrl.trim().length > 0
      ? inputUrl
      : undefined;

  return {
    ...metadata,
    ...(password !== undefined ? { password } : {}),
    ...(url !== undefined ? { url } : {}),
  };
};

export interface ConnectionStoreShape {
  readonly list: Effect.Effect<ReadonlyArray<Connection>>;
  readonly get: (id: ConnectionId) => Effect.Effect<Connection, NotFound>;
  readonly getSecret: (id: ConnectionId) => Effect.Effect<Option.Option<ConnectionSecret>>;
  readonly create: (input: ConnectionInput) => Effect.Effect<Connection, ValidationError>;
  readonly update: (id: ConnectionId, input: ConnectionInput) => Effect.Effect<Connection, ValidationError | NotFound>;
  readonly remove: (id: ConnectionId) => Effect.Effect<void, NotFound>;
  readonly touch: (id: ConnectionId) => Effect.Effect<void>;
}

export class ConnectionStore extends Context.Service<ConnectionStore, ConnectionStoreShape>()(
  "dbchat/Services/ConnectionStore",
) {}
