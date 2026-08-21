/**
 * AgentService backed by Claude Code, Codex, and OpenCode drivers. All three
 * share the guarded database tool layer and approval flow in src/agent/*.
 */
import { AgentError, type ApprovalId, type ChatEvent, type MessageId, NotFound, type ThreadId } from "@dbchat/contracts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { makeChatHub } from "../agent/hub.ts";
import { buildCatalog, resolveModel } from "../agent/models.ts";
import { type ChatRepoShape, makeChatRepo, newId } from "../agent/repo.ts";
import { type ActiveTurn, loadSchemaSummary, type PendingApproval, runTurn } from "../agent/session.ts";
import { buildSuggestPrompt, runSuggest } from "../agent/suggest.ts";
import { forceReadOnlyDriver, makeAiWriteExecutor } from "../agent/writeGate.ts";
import { ServerConfig } from "../config.ts";
import { AgentService } from "../Services/AgentService.ts";
import { ConnectionStore } from "../Services/ConnectionStore.ts";
import { type Driver, DriverRegistry } from "../Services/DriverRegistry.ts";

/** Exposed so rpc/chat.ts can read/write threads without a second service. */
export class ChatRepo extends Context.Service<ChatRepo, ChatRepoShape>()("dbchat/agent/ChatRepo") {}

export const ChatRepoLive = Layer.effect(ChatRepo, makeChatRepo);

const isTerminal = (e: ChatEvent) => e._tag === "TurnDone" || e._tag === "Error";

export const AgentServiceLive = Layer.effect(
  AgentService,
  Effect.gen(function* () {
    const repo: ChatRepoShape = yield* ChatRepo;
    const store = yield* ConnectionStore;
    const registry = yield* DriverRegistry;
    const config = yield* ServerConfig;
    const hub = yield* makeChatHub;
    const layerScope = yield* Effect.scope;

    const defaultModel = config.model;
    const catalog = buildCatalog(defaultModel);
    // Give provider runtimes a clean working directory rather than pointing
    // their default project context at the database and key in homeDir.
    const cwd = join(config.homeDir, "agent-workspace");
    mkdirSync(cwd, { recursive: true });
    const agentHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
    const serverUrl = `http://${agentHost.includes(":") ? `[${agentHost}]` : agentHost}:${config.port}`;
    const activeTurns = new Map<ThreadId, ActiveTurn>();
    const pendingApprovals = new Map<ApprovalId, PendingApproval>();
    const log = (msg: string, data?: Record<string, unknown>) => Effect.logInfo(msg, data ?? {});

    const executeWrite = makeAiWriteExecutor({
      getThread: repo.getThread,
      getApproval: repo.getApproval,
      getConnection: store.get,
      acquireDriver: registry.acquire,
    });

    const deps = (threadId: ThreadId, connectionId: Parameters<typeof registry.acquire>[0], model: string) => ({
      repo,
      hub,
      acquireDriver: registry.acquire(connectionId).pipe(Effect.map(forceReadOnlyDriver)) as Effect.Effect<Driver, unknown>,
      // Fail closed if the connection policy cannot be loaded.
      writeApprovalRequired: store.get(connectionId).pipe(
        Effect.map((connection) => connection.readOnlyForAi),
        Effect.catch(() => Effect.succeed(true)),
      ),
      executeWrite,
      pendingApprovals,
      model,
      cwd,
      serverUrl,
      log: (m: string, d?: Record<string, unknown>) => log(m, { threadId, ...d }),
    });

    const send: AgentService["Service"]["send"] = (input) =>
      Stream.callback<ChatEvent, NotFound | AgentError>((queue) =>
        Effect.gen(function* () {
          const thread = yield* repo.getThread(input.threadId);
          const connection = yield* store.get(thread.connectionId);
          // input.model > thread.model > DBCHAT_MODEL, and it must be in the catalog.
          const resolved = resolveModel({
            requested: input.model,
            threadModel: thread.model,
            defaultModel,
            catalog,
          });
          if (!resolved.ok) {
            return yield* Effect.fail(new AgentError({ message: resolved.reason ?? "Unknown model" }));
          }
          const model = resolved.model;
          const messageId = newId("m") as MessageId;
          // Claim the thread synchronously with the busy check (no yield in
          // between), so two concurrent sends cannot both start a turn.
          const placeholder: ActiveTurn = { messageId, query: { interrupt: async () => undefined } };
          const claimed = yield* Effect.sync(() => {
            if (activeTurns.has(thread.id)) return false;
            activeTurns.set(thread.id, placeholder);
            return true;
          });
          if (!claimed) {
            return yield* Effect.fail(new AgentError({ message: "busy: a turn is already running on this thread" }));
          }
          // Subscribe BEFORE starting the turn so no event is missed. If that
          // fails, give the claim back.
          const feedStream = yield* hub.subscribeScoped(thread.id).pipe(
            Effect.tapCause(() => Effect.sync(() => activeTurns.delete(thread.id))),
          );
          const feed = yield* Effect.forkScoped(
            feedStream.pipe(
              Stream.takeUntil(isTerminal),
              Stream.runForEach((e) => Queue.offer(queue, e)),
              Effect.andThen(Queue.end(queue)),
            ),
          );
          // Persist before the turn so a reload reopens the picker on this model.
          if (thread.model !== model) yield* repo.setThreadModel(thread.id, model);
          const turn = runTurn({
            deps: deps(thread.id, thread.connectionId, model),
            thread: { ...thread, model },
            connection,
            input,
            messageId,
            onQuery: (q) => activeTurns.set(thread.id, { messageId, query: q }),
          }).pipe(
            Effect.catchCause((cause) =>
              hub.publish(thread.id, { _tag: "Error", message: `Agent crashed: ${String(cause)}` }).pipe(
                Effect.andThen(hub.publish(thread.id, { _tag: "TurnDone", messageId })),
              ),
            ),
            Effect.ensuring(Effect.sync(() => activeTurns.delete(thread.id))),
          );
          // The turn outlives the RPC stream (client may disconnect); it lives in the layer scope.
          yield* Effect.forkIn(turn, layerScope);
          return feed;
        }),
      );

    const events: AgentService["Service"]["events"] = (threadId) =>
      Stream.unwrap(repo.getThread(threadId).pipe(Effect.map(() => hub.subscribe(threadId))));

    const abort: AgentService["Service"]["abort"] = (threadId) =>
      repo.getThread(threadId).pipe(
        Effect.andThen(
          Effect.promise(async () => {
            const active = activeTurns.get(threadId);
            if (!active) return;
            await active.query.interrupt().catch(() => undefined);
          }),
        ),
      );

    const resolveApproval: AgentService["Service"]["resolveApproval"] = (approvalId, approve) =>
      Effect.gen(function* () {
        const pending = pendingApprovals.get(approvalId);
        if (!pending) return yield* Effect.fail(new NotFound({ entity: "approval", id: approvalId }));
        yield* Deferred.succeed(pending.decision, approve);
      });

    const suggest: AgentService["Service"]["suggest"] = (req) =>
      Effect.gen(function* () {
        const connection = yield* store.get(req.connectionId).pipe(Effect.option);
        const driver = yield* registry.acquire(req.connectionId).pipe(Effect.option);
        const schema =
          driver._tag === "Some"
            ? yield* loadSchemaSummary(req.connectionId, driver.value).pipe(Effect.catchCause(() => Effect.succeed("")))
            : "";
        const dialect = driver._tag === "Some" ? driver.value.dialect : connection._tag === "Some" ? connection.value.dialect : "sql";
        return yield* runSuggest(buildSuggestPrompt({ dialect, schema, sql: req.sql, cursor: req.cursor }), cwd);
      });

    return AgentService.of({ send, events, abort, resolveApproval, suggest });
  }),
).pipe(Layer.provideMerge(ChatRepoLive));
