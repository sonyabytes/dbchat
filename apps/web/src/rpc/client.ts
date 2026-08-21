/**
 * Typed RPC client over the server WebSocket (mirrors t3code client-runtime/rpc/session.ts).
 *
 *   callRpc((c) => c["connection.list"]())            → Promise<Connection[]>
 *   streamRpc((c) => c["chat.send"](input), onEvent) → () => void  (abort)
 */
import { DbchatRpcs } from "@dbchat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

const makeClient = RpcClient.make(DbchatRpcs);
/** The typed client: `client["connection.list"]()`, `client["chat.send"](input)` (Stream). */
export type Client = typeof makeClient extends Effect.Effect<infer A, any, any> ? A : never;

/**
 * Server URL resolution, first match wins:
 *   1. `?server=ws://…` query param (set by the desktop shell, which picks a free port per launch)
 *   2. `window.dbchat.serverUrl` (desktop preload bridge, same value)
 *   3. `VITE_DBCHAT_RPC_URL` build-time env
 *   4. the dev default
 */
function resolveRpcUrl(): string {
  if (typeof window !== "undefined") {
    const fromQuery = new URLSearchParams(window.location.search).get("server");
    if (fromQuery && /^wss?:\/\//.test(fromQuery)) return fromQuery;
    const fromBridge = (window as unknown as { dbchat?: { serverUrl?: string } }).dbchat?.serverUrl;
    if (fromBridge) return fromBridge;
  }
  return (import.meta.env.VITE_DBCHAT_RPC_URL as string | undefined) ?? "ws://127.0.0.1:4800/rpc";
}
export const RPC_URL: string = resolveRpcUrl();

class RpcClientService extends Context.Service<RpcClientService, Client>()("dbchat/web/RpcClient") {}

const ProtocolLive = RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
  Layer.provide(Socket.layerWebSocket(RPC_URL, { openTimeout: "10 seconds" })),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson),
);

const ClientLive = Layer.effect(RpcClientService, makeClient).pipe(
  Layer.provide(ProtocolLive),
);

/** One runtime for the whole app; the socket is opened lazily on first use. */
export const rpcRuntime = ManagedRuntime.make(ClientLive);

/** Run a unary RPC and get a Promise (for react-query `queryFn` / `mutationFn`). */
export function callRpc<A, E>(fn: (client: Client) => Effect.Effect<A, E>, options?: { signal?: AbortSignal }): Promise<A> {
  return rpcRuntime.runPromise(Effect.flatMap(RpcClientService, fn), options?.signal ? { signal: options.signal } : undefined);
}

/** Subscribe to a streaming RPC. Returns an abort function (interrupts the fiber = cancels on the server). */
export function streamRpc<A, E>(
  fn: (client: Client) => Stream.Stream<A, E>,
  onEvent: (event: A) => void,
  handlers?: { onError?: (error: E | unknown) => void; onDone?: () => void },
): () => void {
  const fiber = rpcRuntime.runFork(
    Effect.flatMap(RpcClientService, (client) =>
      fn(client).pipe(
        Stream.runForEach((e) => Effect.sync(() => onEvent(e))),
        Effect.tap(() => Effect.sync(() => handlers?.onDone?.())),
        Effect.catchCause((cause) => Effect.sync(() => handlers?.onError?.(cause))),
      ),
    ),
  );
  return () => {
    rpcRuntime.runFork(Fiber.interrupt(fiber));
  };
}
