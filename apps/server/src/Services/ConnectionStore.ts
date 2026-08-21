import type { Connection, ConnectionId, ConnectionInput, NotFound, ValidationError } from "@dbchat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

/** Resolved secret for a connection: password and/or URL (never sent to the client). */
export interface ConnectionSecret {
  readonly password?: string;
  readonly url?: string;
}

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
