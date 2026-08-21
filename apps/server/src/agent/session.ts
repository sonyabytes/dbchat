/**
 * One agent turn = one `query()` call against the Claude Agent SDK, resumed via
 * the thread's sdkSessionId. Emits ChatEvents on the hub and persists the
 * assistant message when the turn completes.
 */
import { type Options, type Query, query } from "@anthropic-ai/claude-agent-sdk";
import {
  type ApprovalId,
  type ChatEvent,
  type ChatSendInput,
  type Connection,
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
import { MCP_SERVER_NAME, TurnNormalizer } from "./events.ts";
import type { ChatHub } from "./hub.ts";
import { buildSystemPrompt, buildUserPrompt, schemaSummary } from "./prompt.ts";
import { type ChatRepoShape, newId } from "./repo.ts";
import { makeDbchatMcpServer, type ProposeWriteOutcome } from "./tools.ts";
import type { AiWriteRequest, AiWriteResult } from "./writeGate.ts";

export const APPROVAL_TIMEOUT = Duration.minutes(10);

export const TOOL_NAMES = ["list_schemas", "describe_table", "sample_rows", "run_sql", "explain", "propose_write"] as const;
export const MCP_TOOL_NAMES = TOOL_NAMES.map((t) => `mcp__${MCP_SERVER_NAME}__${t}`);

export interface PendingApproval {
  readonly threadId: Thread["id"];
  readonly decision: Deferred.Deferred<boolean>;
}

export interface SessionDeps {
  readonly repo: ChatRepoShape;
  readonly hub: ChatHub;
  readonly acquireDriver: Effect.Effect<Driver, unknown>;
  /** Fresh connection policy; true means a persisted approval is required. */
  readonly writeApprovalRequired: Effect.Effect<boolean>;
  /** Server-owned capability; the only AI path that may set driver readOnly:false. */
  readonly executeWrite: (request: AiWriteRequest) => Effect.Effect<AiWriteResult, unknown>;
  readonly pendingApprovals: Map<ApprovalId, PendingApproval>;
  readonly model: string;
  readonly cwd: string;
  readonly log: (msg: string, data?: Record<string, unknown>) => Effect.Effect<void>;
}

export interface ActiveTurn {
  readonly messageId: MessageId;
  readonly query: Query;
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
  connection: Connection;
  input: ChatSendInput;
  messageId: MessageId;
  onQuery: (q: Query) => void;
}) =>
  Effect.gen(function* () {
    const { deps, connection, input, messageId } = args;
    let thread = args.thread;
    const publish = (e: ChatEvent) => deps.hub.publish(thread.id, e);
    const normalizer = new TurnNormalizer(messageId);
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

    // 2. Schema summary (best effort).
    const driverResult = yield* Effect.result(deps.acquireDriver);
    let schema = "";
    let dialect: string = connection.dialect;
    if (driverResult._tag === "Success") {
      dialect = driverResult.success.dialect;
      schema = yield* loadSchemaSummary(thread.connectionId, driverResult.success).pipe(
        Effect.catch((e) => deps.log("schema summary failed", { error: String(e) }).pipe(Effect.as(""))),
      );
    } else {
      yield* deps.log("driver unavailable for thread", { threadId: thread.id, error: String(driverResult.failure) });
    }

    // 3. Tools: events from tools are published AND folded into the persisted parts.
    const emit = (e: ChatEvent) => Effect.sync(() => normalizer.ingestToolEvent(e)).pipe(Effect.andThen(publish(e)));
    const mcpServer = makeDbchatMcpServer({
      connectionId: thread.connectionId,
      messageId,
      run,
      driver: deps.acquireDriver,
      emit,
      proposeWrite: ({ sql, estimatedRows }) => proposeWrite({ deps, thread, messageId, sql, estimatedRows, emit }),
    });

    // 4. Run the SDK query and normalise.
    const q = query({
      prompt: buildUserPrompt(input.text, input.context),
      options: buildQueryOptions({
        model: deps.model,
        cwd: deps.cwd,
        systemPrompt: buildSystemPrompt({ connection, dialect, schema }),
        resume: thread.sdkSessionId,
        mcpServer,
        stderr: (d) => {
          if (process.env.DBCHAT_AGENT_DEBUG) console.error("[claude]", d.trimEnd());
        },
      }),
    });
    args.onQuery(q);

    let sawTurnDone = false;
    let persisted = false;
    yield* Stream.fromAsyncIterable(q, (e) => e).pipe(
      Stream.runForEach((msg) =>
        Effect.gen(function* () {
          const events = normalizer.handle(msg);
          if (normalizer.sessionId && normalizer.sessionId !== thread.sdkSessionId) {
            thread = { ...thread, sdkSessionId: normalizer.sessionId };
            yield* deps.repo.setSdkSessionId(thread.id, normalizer.sessionId);
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
  messageId: MessageId;
  sql: string;
  estimatedRows: number | undefined;
  emit: (e: ChatEvent) => Effect.Effect<void>;
}): Effect.Effect<ProposeWriteOutcome> =>
  Effect.gen(function* () {
    const { deps, thread, messageId, sql, emit } = args;
    const approvalRequired = yield* deps.writeApprovalRequired;

    // The connection policy is re-checked by executeWrite immediately before
    // reaching the raw driver. This first check only decides whether to show an
    // approval card.
    if (!approvalRequired) {
      const direct = yield* Effect.result(deps.executeWrite({ threadId: thread.id, sql }));
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
      messageId,
      sql,
      ...(args.estimatedRows !== undefined ? { rowEstimate: args.estimatedRows } : {}),
    });
    yield* emit({
      _tag: "ApprovalRequested",
      messageId,
      approvalId,
      sql,
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
      deps.executeWrite({ threadId: thread.id, sql, approvalId }),
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
