/**
 * ChatRepo: sqlite persistence for threads / messages / approvals
 * (tables from migration 0001_Init). Pure data access, no agent logic.
 */
import {
  type ApprovalId,
  type ApprovalStatus,
  type ConnectionId,
  type Message,
  type MessageId,
  type MessagePart,
  type MessageRole,
  NotFound,
  type Thread,
  type ThreadId,
} from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError } from "effect/unstable/sql/SqlError";

export interface ApprovalRow {
  readonly id: ApprovalId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId | undefined;
  readonly sql: string;
  readonly rowEstimate: number | undefined;
  readonly status: ApprovalStatus;
  readonly resultJson: string | undefined;
  readonly createdAt: string;
  readonly resolvedAt: string | undefined;
}

export interface ChatRepoShape {
  readonly listThreads: (connectionId: ConnectionId) => Effect.Effect<ReadonlyArray<Thread>>;
  readonly getThread: (id: ThreadId) => Effect.Effect<Thread, NotFound>;
  readonly createThread: (connectionId: ConnectionId, title: string) => Effect.Effect<Thread, NotFound>;
  readonly deleteThread: (id: ThreadId) => Effect.Effect<void, NotFound>;
  readonly setThreadTitle: (id: ThreadId, title: string) => Effect.Effect<void>;
  readonly setSdkSessionId: (id: ThreadId, sdkSessionId: string) => Effect.Effect<void>;
  /** Remembers the model a thread last ran on. */
  readonly setThreadModel: (id: ThreadId, model: string) => Effect.Effect<void>;
  readonly touchThread: (id: ThreadId) => Effect.Effect<void>;
  readonly listMessages: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Message>>;
  readonly countMessages: (threadId: ThreadId) => Effect.Effect<number>;
  readonly insertMessage: (msg: Message) => Effect.Effect<void>;
  readonly createApproval: (a: {
    id: ApprovalId;
    threadId: ThreadId;
    messageId: MessageId;
    sql: string;
    rowEstimate?: number;
  }) => Effect.Effect<void>;
  readonly getApproval: (id: ApprovalId) => Effect.Effect<ApprovalRow, NotFound>;
  readonly setApprovalStatus: (id: ApprovalId, status: ApprovalStatus, result?: unknown) => Effect.Effect<void>;
}

interface ThreadRow {
  id: string;
  connection_id: string;
  title: string;
  sdk_session_id: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
}
interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  parts_json: string;
  created_at: string;
}
interface ApprovalDbRow {
  id: string;
  thread_id: string;
  message_id: string | null;
  sql: string;
  row_estimate: number | null;
  status: string;
  result_json: string | null;
  created_at: string;
  resolved_at: string | null;
}

const toThread = (r: ThreadRow): Thread => ({
  id: r.id as ThreadId,
  connectionId: r.connection_id as ConnectionId,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.sdk_session_id ? { sdkSessionId: r.sdk_session_id } : {}),
  ...(r.model ? { model: r.model } : {}),
});

const toMessage = (r: MessageRow): Message => ({
  id: r.id as MessageId,
  threadId: r.thread_id as ThreadId,
  role: r.role as MessageRole,
  parts: safeParseParts(r.parts_json),
  createdAt: r.created_at,
});

const safeParseParts = (json: string): ReadonlyArray<MessagePart> => {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as ReadonlyArray<MessagePart>) : [];
  } catch {
    return [];
  }
};

const toApproval = (r: ApprovalDbRow): ApprovalRow => ({
  id: r.id as ApprovalId,
  threadId: r.thread_id as ThreadId,
  messageId: (r.message_id ?? undefined) as MessageId | undefined,
  sql: r.sql,
  rowEstimate: r.row_estimate ?? undefined,
  status: r.status as ApprovalStatus,
  resultJson: r.result_json ?? undefined,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at ?? undefined,
});

export const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const makeChatRepo = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = () => new Date().toISOString();

  const getThread: ChatRepoShape["getThread"] = (id) =>
    sql<ThreadRow>`SELECT * FROM threads WHERE id = ${id}`.pipe(
      Effect.orDie,
      Effect.flatMap((rows) =>
        rows[0] ? Effect.succeed(toThread(rows[0])) : Effect.fail(new NotFound({ entity: "thread", id })),
      ),
    );

  const repo: ChatRepoShape = {
    listThreads: (connectionId) =>
      sql<ThreadRow>`SELECT * FROM threads WHERE connection_id = ${connectionId} ORDER BY updated_at DESC`.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map(toThread)),
      ),
    getThread,
    createThread: (connectionId, title) =>
      Effect.gen(function* () {
        const t: Thread = { id: newId("t") as ThreadId, connectionId, title, createdAt: now(), updatedAt: now() };
        yield* sql`INSERT INTO threads (id, connection_id, title, created_at, updated_at)
          VALUES (${t.id}, ${t.connectionId}, ${t.title}, ${t.createdAt}, ${t.updatedAt})`.pipe(
          Effect.catchTag("SqlError", (e: SqlError) =>
            // FK violation ⇒ the connection row does not exist in sqlite.
            e.reason._tag === "ConstraintError" || /FOREIGN KEY/i.test(e.message)
              ? Effect.fail(new NotFound({ entity: "connection", id: connectionId }))
              : Effect.die(e),
          ),
        );
        return t;
      }),
    deleteThread: (id) =>
      getThread(id).pipe(Effect.andThen(sql`DELETE FROM threads WHERE id = ${id}`.pipe(Effect.orDie, Effect.asVoid))),
    setThreadTitle: (id, title) =>
      sql`UPDATE threads SET title = ${title}, updated_at = ${now()} WHERE id = ${id}`.pipe(Effect.orDie, Effect.asVoid),
    setSdkSessionId: (id, sdkSessionId) =>
      sql`UPDATE threads SET sdk_session_id = ${sdkSessionId} WHERE id = ${id}`.pipe(Effect.orDie, Effect.asVoid),
    setThreadModel: (id, model) =>
      sql`UPDATE threads SET model = ${model} WHERE id = ${id}`.pipe(Effect.orDie, Effect.asVoid),
    touchThread: (id) => sql`UPDATE threads SET updated_at = ${now()} WHERE id = ${id}`.pipe(Effect.orDie, Effect.asVoid),
    listMessages: (threadId) =>
      sql<MessageRow>`SELECT * FROM messages WHERE thread_id = ${threadId} ORDER BY created_at ASC, rowid ASC`.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map(toMessage)),
      ),
    countMessages: (threadId) =>
      sql<{ n: number }>`SELECT COUNT(*) AS n FROM messages WHERE thread_id = ${threadId}`.pipe(
        Effect.orDie,
        Effect.map((rows) => Number(rows[0]?.n ?? 0)),
      ),
    insertMessage: (m) =>
      sql`INSERT INTO messages (id, thread_id, role, parts_json, created_at)
        VALUES (${m.id}, ${m.threadId}, ${m.role}, ${JSON.stringify(m.parts)}, ${m.createdAt})`.pipe(
        Effect.orDie,
        Effect.asVoid,
      ),
    createApproval: (a) =>
      sql`INSERT INTO approvals (id, thread_id, message_id, sql, row_estimate, status, created_at)
        VALUES (${a.id}, ${a.threadId}, ${a.messageId}, ${a.sql}, ${a.rowEstimate ?? null}, 'pending', ${now()})`.pipe(
        Effect.orDie,
        Effect.asVoid,
      ),
    getApproval: (id) =>
      sql<ApprovalDbRow>`SELECT * FROM approvals WHERE id = ${id}`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) =>
          rows[0] ? Effect.succeed(toApproval(rows[0])) : Effect.fail(new NotFound({ entity: "approval", id })),
        ),
      ),
    setApprovalStatus: (id, status, result) =>
      sql`UPDATE approvals SET status = ${status}, result_json = ${result === undefined ? null : JSON.stringify(result)},
        resolved_at = ${now()} WHERE id = ${id}`.pipe(Effect.orDie, Effect.asVoid),
  };
  return repo;
});
