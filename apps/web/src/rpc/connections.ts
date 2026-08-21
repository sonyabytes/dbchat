/**
 * connection.* RPC bindings.
 *
 * `connection.connect` doubles as the status probe: the server acquires the driver
 * and returns a `ConnectionStatus` (state + latency), so we cache it per connection
 * and both the connections screen and the workspace header read the same entry.
 */
import type { ConnectionId, ConnectionInput } from "@dbchat/contracts";
import { RPC } from "@dbchat/contracts";
import { queryOptions } from "@tanstack/react-query";

import { callRpc } from "./client";

export const connectionKeys = {
  list: ["connection.list"] as const,
  connect: (id: ConnectionId) => ["connection.connect", id] as const,
};

/** Connect (idempotent on the server) and return the live status. */
export const connectionConnectQuery = (id: ConnectionId) =>
  queryOptions({
    queryKey: connectionKeys.connect(id),
    queryFn: () => callRpc((c) => c[RPC.connectionConnect]({ id })),
    staleTime: 60_000,
    retry: false,
  });

export const connectionApi = {
  create: (input: ConnectionInput) => callRpc((c) => c[RPC.connectionCreate](input)),
  update: (id: ConnectionId, input: ConnectionInput) => callRpc((c) => c[RPC.connectionUpdate]({ id, input })),
  remove: (id: ConnectionId) => callRpc((c) => c[RPC.connectionDelete]({ id })),
  test: (input: ConnectionInput) => callRpc((c) => c[RPC.connectionTest](input)),
  connect: (id: ConnectionId) => callRpc((c) => c[RPC.connectionConnect]({ id })),
  disconnect: (id: ConnectionId) => callRpc((c) => c[RPC.connectionDisconnect]({ id })),
};
