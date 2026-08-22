/**
 * Shared turn orchestration for Claude Code, Codex, and OpenCode. Provider
 * drivers stream into the same ChatEvents and use the same guarded DB tools;
 * provider-specific session ids share the legacy sdkSessionId column.
 */
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import {
  type ApprovalId,
  type ChatEvent,
  type ChatSendInput,
  type ConnectionId,
  type GitRepository,
  type Message,
  type MessageId,
  type Thread,
} from "@dbchat/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { Driver } from "../Services/DriverRegistry.ts";
import { claudeSdkOptions } from "./claudeRuntime.ts";
import { resolveCliRuntime } from "./cliRuntime.ts";
import { startCodexTurn } from "./codexDriver.ts";
import type { AgentTurnHandle } from "./driver.ts";
import { DriverEventCollector } from "./driverEvents.ts";
import { MCP_SERVER_NAME, TurnNormalizer } from "./events.ts";
import type { ChatHub } from "./hub.ts";
import { findModel } from "./models.ts";
import { startOpenCodeTurn } from "./opencodeDriver.ts";
import { buildSystemPrompt, buildUserPrompt, schemaSummary } from "./prompt.ts";
import { providerSession, setProviderSession } from "./providerSessions.ts";
import { type ChatRepoShape, newId } from "./repo.ts";
import { DBCHAT_TOOL_NAMES, invokeDbchatTool, makeDbchatMcpServer, type ProposeWriteOutcome, type ToolContext, type ToolDatabase } from "./tools.ts";
import type { AiWriteRequest, AiWriteResult } from "./writeGate.ts";

export const APPROVAL_TIMEOUT = Duration.minutes(10);

export const TOOL_NAMES = DBCHAT_TOOL_NAMES;
export const MCP_TOOL_NAMES = TOOL_NAMES.map((t) => `mcp__${MCP_SERVER_NAME}__${t}`);

export interface PendingApproval {
  readonly threadId: Thread["id"];
  readonly decision: Deferred.Deferred<boolean>;
}

export interface SessionDeps {
  readonly repo: ChatRepoShape;
  readonly hub: ChatHub;
  readonly databases: ReadonlyArray<ToolDatabase>;
  readonly repositories: ReadonlyArray<GitRepository>;
  /** Fresh connection policy; true means a persisted approval is required. */
  readonly writeApprovalRequired: (connectionId: ConnectionId) => Effect.Effect<boolean>;
  /** Server-owned capability; the only AI path that may set driver readOnly:false. */
  readonly executeWrite: (request: AiWriteRequest) => Effect.Effect<AiWriteResult, unknown>;
  readonly pendingApprovals: Map<ApprovalId, PendingApproval>;
  readonly model: string;
  readonly cwd: string;
  readonly serverUrl?: string;
  readonly log: (msg: string, data?: Record<string, unknown>) => Effect.Effect<void>;
}

export interface ActiveTurn {
  readonly messageId: MessageId;
  readonly query: Pick<AgentTurnHandle, "interrupt">;
}

/** Cheap per-connection cache for the schema summary. */
const summaryCache = new Map<string, { at: number; text: string }>();
const SUMMARY_TTL_MS = 5 * 60_000;

export const loadSchemaSummary = (connectionId: string, driver: Driver) =>
  Effect.gen(function* () {
    const cached = summaryCache.get(connectionId);
    if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.text;
    const schemas = yield* driver.introspect;
    const tables = schemas.flatMap((s) => s.tables).slice(0, 40);
    const details = yield* Effect.forEach(
      tables,
      (t) => driver.describeTable(t.schema, t.name).pipe(Effect.option),
      { concurrency: 4 },
    );
    const map = new Map(
      details.flatMap((d, i) => (d._tag === "Some" ? [[`${tables[i]!.schema}.${tables[i]!.name}`, d.value] as const] : [])),
    );
    const text = schemaSummary(schemas, map);
    summaryCache.set(connectionId, { at: Date.now(), text });
    return text;
  });

export const buildQueryOptions = (args: {
  model: string;
  cwd: string;
  systemPrompt: string;
  resume: string | undefined;
  mcpServer: ReturnType<typeof makeDbchatMcpServer>;
  stderr?: (data: string) => void;
}): Options => ({
  model: args.model,
  cwd: args.cwd,
  systemPrompt: args.systemPrompt,
  ...(args.resume ? { resume: args.resume } : {}),
  permissionMode: "default",
  // No built-in tools at all (no Bash/Read/Write/Edit/Web*); only our MCP server.
  tools: [],
  disallowedTools: ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "Skill", "TodoWrite"],
  // Not in allowedTools on purpose: bare entries would bypass canUseTool (SDK warns).
  canUseTool: async (toolName) =>
    MCP_TOOL_NAMES.includes(toolName)
      ? { behavior: "allow" }
      : { behavior: "deny", message: `Tool ${toolName} is not available in dbchat.` },
  mcpServers: { [MCP_SERVER_NAME]: args.mcpServer },
  strictMcpConfig: true,
  includePartialMessages: true,
  persistSession: true,
  maxTurns: 25,
  // settingSources + env + binary: see claudeRuntime.ts (user settings.json, login-shell env, chosen `claude`).
  ...claudeSdkOptions("dbchat/0.1.0"),
  ...(args.stderr ? { stderr: args.stderr } : {}),
});

/**
 * Runs the whole turn to completion (intended to be forked). Publishes every
 * event to the hub; never fails — errors become `Error` + `TurnDone` events.
 */
export const runTurn = (args: {
  deps: SessionDeps;
  thread: Thread;
  input: ChatSendInput;
  messageId: MessageId;
  onQuery: (q: Pick<AgentTurnHandle, "interrupt">) => void;
}) =>
  Effect.gen(function* () {
    const { deps, input, messageId } = args;
    let thread = args.thread;
    const publish = (e: ChatEvent) => deps.hub.publish(thread.id, e);
    const run = Effect.runPromiseWith(yield* Effect.context<never>());

    // 1. Persist the user message (+ title from the first one).
    const userMessage: Message = {
      id: newId("m") as MessageId,
      threadId: thread.id,
      role: "user",
      parts: [{ _tag: "Text", text: input.text }],
      createdAt: new Date().toISOString(),
    };
    const count = yield* deps.repo.countMessages(thread.id);
    yield* deps.repo.insertMessage(userMessage);
    if (count === 0) yield* deps.repo.setThreadTitle(thread.id, input.text.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat");
    yield* publish({ _tag: "UserMessage", message: userMessage });

    // 2. Best-effort schema summaries for every attached database.
    const databases = yield* Effect.forEach(
      deps.databases,
      ({ connection, driver }) => Effect.gen(function* () {
        const result = yield* Effect.result(driver);
        if (result._tag === "Failure") {
          yield* deps.log("driver unavailable for thread source", { threadId: thread.id, connectionId: connection.id, error: String(result.failure) });
          return { connection, dialect: connection.dialect, schema: "" };
        }
        const schema = yield* loadSchemaSummary(connection.id, result.success).pipe(
          Effect.catch((error) => deps.log("schema summary failed", { connectionId: connection.id, error: String(error) }).pipe(Effect.as(""))),
        );
        return { connection, dialect: result.success.dialect, schema };
      }),
      { concurrency: 4 },
    );

    const provider = findModel(deps.model)?.provider ?? "anthropic";
    const userPrompt = buildUserPrompt(input.text, input.context);
    const systemPrompt = buildSystemPrompt({ databases, repositories: deps.repositories });
    const saveProviderSession = (sessionId: string) => Effect.gen(function* () {
      const stored = setProviderSession(thread.sdkSessionId, provider, sessionId);
      if (stored === thread.sdkSessionId) return;
      thread = { ...thread, sdkSessionId: stored };
      yield* deps.repo.setSdkSessionId(thread.id, stored);
    });

    const makeToolContext = (emit: (event: ChatEvent) => Effect.Effect<void>): ToolContext => ({
      databases: deps.databases,
      repositories: deps.repositories,
      messageId,
      run,
      emit,
      proposeWrite: ({ connectionId, sql, estimatedRows }) => proposeWrite({ deps, thread, connectionId, messageId, sql, estimatedRows, emit }),
    });
    const exposeInterrupt = (handle: Pick<AgentTurnHandle, "interrupt">) => {
      args.onQuery({
        interrupt: async () => {
          // Release any tool call waiting on a write approval before stopping
          // the provider process, otherwise its completion chain can remain
          // blocked until the ten-minute approval timeout.
          const pending = [...deps.pendingApprovals.values()].filter((approval) => approval.threadId === thread.id);
          await Promise.all(pending.map((approval) => run(Deferred.succeed(approval.decision, false))));
          await handle.interrupt();
        },
      });
    };

    if (provider !== "anthropic") {
      const collector = new DriverEventCollector(messageId);
      const emit = (event: ChatEvent) => Effect.sync(() => collector.ingestToolEvent(event)).pipe(Effect.andThen(publish(event)));
      const toolContext = makeToolContext(emit);
      const callbacks = {
        onSession: (sessionId: string) => run(saveProviderSession(sessionId)),
        onText: (text: string) => {
          const event = collector.text(text);
          return event ? run(publish(event)) : Promise.resolve();
        },
        onThinking: (text: string) => {
          const event = collector.thinking(text);
          return event ? run(publish(event)) : Promise.resolve();
        },
        callTool: async (name: string, toolInput: unknown, callId: string) => {
          await run(publish(collector.toolStart(callId, name, toolInput)));
          const result = await invokeDbchatTool(toolContext, name, toolInput);
          await run(publish(collector.toolEnd(callId, result.content, result.isError === true)));
          return result;
        },
      };
      const runtime = resolveCliRuntime(provider);
      if (!runtime.binary) {
        yield* publish({ _tag: "Error", message: `${provider === "openai" ? "Codex" : "OpenCode"} CLI was not found on PATH.` });
        yield* deps.repo.touchThread(thread.id);
        yield* publish({ _tag: "TurnDone", messageId, model: deps.model });
        return;
      }
      const turnArgs = {
        binary: runtime.binary,
        env: runtime.env,
        model: deps.model,
        cwd: deps.cwd,
        systemPrompt,
        userPrompt,
        ...(deps.serverUrl ? { serverUrl: deps.serverUrl } : {}),
        ...(providerSession(thread.sdkSessionId, provider) ? { sessionId: providerSession(thread.sdkSessionId, provider)! } : {}),
        callbacks,
      };
      const handle = provider === "openai" ? startCodexTurn(turnArgs) : startOpenCodeTurn(turnArgs);
      exposeInterrupt(handle);
      const outcome = yield* Effect.promise(() => handle.done);
      if (outcome.error) yield* publish({ _tag: "Error", message: outcome.error });
      if (collector.parts.length > 0) {
        yield* deps.repo.insertMessage({
          id: messageId,
          threadId: thread.id,
          role: "assistant",
          parts: collector.snapshotParts(),
          createdAt: new Date().toISOString(),
        });
      }
      yield* deps.repo.touchThread(thread.id);
      yield* publish({ _tag: "TurnDone", messageId, ...(outcome.usage ? { usage: outcome.usage } : {}), model: deps.model });
      return;
    }

    // Claude SDK path. Tools: events from tools are published AND folded into persisted parts.
    const normalizer = new TurnNormalizer(messageId);
    const emit = (event: ChatEvent) => Effect.sync(() => normalizer.ingestToolEvent(event)).pipe(Effect.andThen(publish(event)));
    const mcpServer = makeDbchatMcpServer(makeToolContext(emit));

    // 4. Run the Claude SDK query and normalise.
    const q = query({
      prompt: userPrompt,
      options: buildQueryOptions({
        model: deps.model,
        cwd: deps.cwd,
        systemPrompt,
        resume: providerSession(thread.sdkSessionId, "anthropic"),
        mcpServer,
        stderr: (d) => {
          if (process.env.DBCHAT_AGENT_DEBUG) console.error("[claude]", d.trimEnd());
        },
      }),
    });
    exposeInterrupt(q);

    let sawTurnDone = false;
    let persisted = false;
    yield* Stream.fromAsyncIterable(q, (e) => e).pipe(
      Stream.runForEach((msg) =>
        Effect.gen(function* () {
          const events = normalizer.handle(msg);
          if (normalizer.sessionId && normalizer.sessionId !== providerSession(thread.sdkSessionId, "anthropic")) {
            yield* saveProviderSession(normalizer.sessionId);
          }
          for (const e of events) {
            if (e._tag === "TurnDone") {
              // Persist BEFORE announcing completion so messages.list is consistent.
              yield* persistAssistant();
              sawTurnDone = true;
              // The normalizer only sees SDK messages; the model came from us.
              yield* publish({ ...e, model: deps.model });
              continue;
            }
            yield* publish(e);
          }
        }),
      ),
      Effect.catch((e) =>
        publish({ _tag: "Error", message: `Agent failed: ${e instanceof Error ? e.message : String(e)}` }),
      ),
    );

    // 5. Always close the turn (interrupted / crashed streams never produce a result).
    if (!sawTurnDone) {
      yield* persistAssistant();
      yield* publish({ _tag: "TurnDone", messageId, usage: normalizer.outcome?.usage, model: deps.model });
    }

    function persistAssistant() {
      return Effect.gen(function* () {
        if (persisted) return;
        persisted = true;
        const parts = normalizer.snapshotParts();
        if (parts.length > 0) {
          yield* deps.repo.insertMessage({
            id: messageId,
            threadId: thread.id,
            role: "assistant",
            parts,
            createdAt: new Date().toISOString(),
          });
        }
        yield* deps.repo.touchThread(thread.id);
      });
    }
  });

/** propose_write: enforce connection policy, then execute directly or wait for approval. */
export const proposeWrite = (args: {
  deps: SessionDeps;
  thread: Thread;
  connectionId: ConnectionId;
  messageId: MessageId;
  sql: string;
  estimatedRows: number | undefined;
  emit: (e: ChatEvent) => Effect.Effect<void>;
}): Effect.Effect<ProposeWriteOutcome> =>
  Effect.gen(function* () {
    const { deps, thread, connectionId, messageId, sql, emit } = args;
    const approvalRequired = yield* deps.writeApprovalRequired(connectionId);

    // The connection policy is re-checked by executeWrite immediately before
    // reaching the raw driver. This first check only decides whether to show an
    // approval card.
    if (!approvalRequired) {
      const direct = yield* Effect.result(deps.executeWrite({ threadId: thread.id, connectionId, sql }));
      if (direct._tag === "Failure") {
        const error = direct.failure instanceof Error ? direct.failure.message : String(direct.failure);
        return { status: "failed", error } as const;
      }
      const rowCount = direct.success.affectedRows ?? direct.success.rows.length;
      return { status: "executed", rowCount } as const;
    }

    const approvalId = newId("ap") as ApprovalId;
    const decision = yield* Deferred.make<boolean>();
    deps.pendingApprovals.set(approvalId, { threadId: thread.id, decision });
    yield* deps.repo.createApproval({
      id: approvalId,
      threadId: thread.id,
      connectionId,
      messageId,
      sql,
      ...(args.estimatedRows !== undefined ? { rowEstimate: args.estimatedRows } : {}),
    });
    yield* emit({
      _tag: "ApprovalRequested",
      messageId,
      approvalId,
      sql,
      source: { kind: "database", id: connectionId },
      ...(args.estimatedRows !== undefined ? { rowEstimate: args.estimatedRows } : {}),
    });

    const approved = yield* Deferred.await(decision).pipe(
      Effect.timeoutOption(APPROVAL_TIMEOUT),
      Effect.map((o) => o._tag === "Some" && o.value),
      Effect.ensuring(Effect.sync(() => deps.pendingApprovals.delete(approvalId))),
    );

    if (!approved) {
      yield* deps.repo.setApprovalStatus(approvalId, "rejected");
      yield* emit({ _tag: "ApprovalResolved", approvalId, status: "rejected" });
      return { status: "rejected" } as const;
    }

    yield* deps.repo.setApprovalStatus(approvalId, "approved");
    yield* emit({ _tag: "ApprovalResolved", approvalId, status: "approved" });

    const result = yield* Effect.result(
      deps.executeWrite({ threadId: thread.id, connectionId, sql, approvalId }),
    );
    if (result._tag === "Failure") {
      const error = result.failure instanceof Error ? result.failure.message : String(result.failure);
      yield* deps.repo.setApprovalStatus(approvalId, "failed", { error });
      yield* emit({ _tag: "ApprovalResolved", approvalId, status: "failed" });
      return { status: "failed", error } as const;
    }
    // The driver reports what the statement *changed*; RETURNING rows are capped
    // at 1 above, so counting them would under-report every multi-row write.
    const rowCount = result.success.affectedRows ?? result.success.rows.length;
    yield* deps.repo.setApprovalStatus(approvalId, "executed", { rowCount });
    yield* emit({ _tag: "ApprovalResolved", approvalId, status: "executed" });
    return { status: "executed", rowCount } as const;
  });
