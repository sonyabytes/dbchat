/** bun scripts/smoke.ts — calls server.health, connection.list and streams chat.send over ws://localhost:4800/rpc */
import { DbchatRpcs, RPC, type ThreadId } from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

const url = process.env.DBCHAT_RPC_URL ?? "ws://127.0.0.1:4800/rpc";

const ProtocolLive = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(url)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson),
);

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(DbchatRpcs);
  const health = yield* client[RPC.serverHealth]();
  console.log("server.health", health);
  const list = yield* client[RPC.connectionList]();
  console.log("connection.list", list.map((c) => `${c.id}:${c.name}`));
  const schemas = yield* client[RPC.schemaList]({ connectionId: list[0]!.id });
  console.log("schema.list", schemas.map((s) => `${s.name}(${s.tables.length})`));
  const events = yield* client[RPC.chatSend]({ threadId: "t1" as ThreadId, text: "top customers" }).pipe(
    Stream.map((e) => e._tag),
    Stream.runCollect,
  );
  console.log("chat.send events", events);
}).pipe(Effect.scoped, Effect.provide(ProtocolLive));

await Effect.runPromise(program);
process.exit(0);
