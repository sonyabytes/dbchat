/**
 * bun scripts/smoke-chat.ts — creates a thread and streams chat.send through the
 * real agent. Requires a running server (DBCHAT_RPC_URL, default ws://127.0.0.1:4800/rpc)
 * and an existing connection id (CONNECTION_ID, default c1). Set THREAD_ID to continue a thread.
 */
import { type ConnectionId, DbchatRpcs, RPC, type ThreadId } from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

const url = process.env.DBCHAT_RPC_URL ?? "ws://127.0.0.1:4800/rpc";
const connectionId = (process.env.CONNECTION_ID ?? "c1") as ConnectionId;
const prompt = process.argv[2] ?? "list the tables";

const ProtocolLive = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(url)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson),
);

const short = (v: unknown, n = 160) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(DbchatRpcs);
  const thread = process.env.THREAD_ID
    ? { id: process.env.THREAD_ID as ThreadId }
    : yield* client[RPC.chatThreadsCreate]({ sources: [{ kind: "database", id: connectionId }] });
  console.log("thread", thread.id);
  const t0 = Date.now();
  yield* client[RPC.chatSend]({ threadId: thread.id, text: prompt }).pipe(
    Stream.runForEach((e) =>
      Effect.sync(() => {
        const at = `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
        switch (e._tag) {
          case "TextDelta":
            return console.log(at, e._tag, JSON.stringify(e.text));
          case "ThinkingDelta":
            return console.log(at, e._tag, JSON.stringify(short(e.text, 60)));
          case "ToolStart":
            return console.log(at, e._tag, e.name, short(e.input));
          case "ToolEnd":
            return console.log(at, e._tag, `${e.durationMs}ms`, e.isError ? "ERROR" : "", short(e.output));
          case "ResultTable":
            return console.log(at, e._tag, `${e.columns.length} cols × ${e.rows.length} rows`, short(e.sql, 80));
          case "TurnDone":
            return console.log(at, e._tag, e.usage);
          default:
            return console.log(at, e._tag, short(e));
        }
      }),
    ),
  );
  const msgs = yield* client[RPC.chatMessagesList]({ threadId: thread.id });
  console.log("persisted messages", msgs.map((m) => `${m.role}:${m.parts.map((p) => p._tag).join(",")}`));
  const threads = yield* client[RPC.chatThreadsList]();
  console.log("thread title", threads.find((t) => t.id === thread.id)?.title, "sdkSessionId", threads.find((t) => t.id === thread.id)?.sdkSessionId);
}).pipe(Effect.scoped, Effect.provide(ProtocolLive));

await Effect.runPromise(program);
process.exit(0);
