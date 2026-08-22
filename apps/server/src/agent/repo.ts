/** SQLite persistence for conversations, source attachments, and approvals. */
import {
  type ApprovalId,
  type ApprovalStatus,
  type ConnectionId,
  type GitRepository,
  type Message,
  type MessageId,
  type MessagePart,
  type MessageRole,
  NotFound,
  type RepositoryId,
  type SourceRef,
  type Thread,
  type ThreadId,
} from "@dbchat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface ApprovalRow {
  readonly id: ApprovalId;
  readonly threadId: ThreadId;
  readonly connectionId: ConnectionId | undefined;
  readonly messageId: MessageId | undefined;
  readonly sql: string;
  readonly rowEstimate: number | undefined;
  readonly status: ApprovalStatus;
  readonly resultJson: string | undefined;
  readonly createdAt: string;
  readonly resolvedAt: string | undefined;
}

export interface ChatRepoShape {
  readonly listThreads: () => Effect.Effect<ReadonlyArray<Thread>>;
  readonly getThread: (id: ThreadId) => Effect.Effect<Thread, NotFound>;
  readonly createThread: (title: string, sources: ReadonlyArray<SourceRef>) => Effect.Effect<Thread, NotFound>;
  readonly setThreadSources: (id: ThreadId, sources: ReadonlyArray<SourceRef>) => Effect.Effect<Thread, NotFound>;
  readonly deleteThread: (id: ThreadId) => Effect.Effect<void, NotFound>;
  readonly setThreadTitle: (id: ThreadId, title: string) => Effect.Effect<void>;
  readonly setSdkSessionId: (id: ThreadId, sdkSessionId: string) => Effect.Effect<void>;
  readonly setThreadModel: (id: ThreadId, model: string) => Effect.Effect<void>;
  readonly touchThread: (id: ThreadId) => Effect.Effect<void>;
  readonly listMessages: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Message>>;
  readonly countMessages: (threadId: ThreadId) => Effect.Effect<number>;
  readonly insertMessage: (msg: Message) => Effect.Effect<void>;
  readonly createApproval: (a: {
    id: ApprovalId;
    threadId: ThreadId;
    connectionId: ConnectionId;
    messageId: MessageId;
    sql: string;
    rowEstimate?: number;
  }) => Effect.Effect<void>;
  readonly getApproval: (id: ApprovalId) => Effect.Effect<ApprovalRow, NotFound>;
  readonly setApprovalStatus: (id: ApprovalId, status: ApprovalStatus, result?: unknown) => Effect.Effect<void>;
  readonly listGitRepositories: () => Effect.Effect<ReadonlyArray<GitRepository>>;
  readonly getGitRepository: (id: RepositoryId) => Effect.Effect<GitRepository, NotFound>;
  readonly insertGitRepository: (repository: GitRepository) => Effect.Effect<void>;
  readonly updateGitRepositoryHead: (id: RepositoryId, branch: string, headCommit: string) => Effect.Effect<GitRepository, NotFound>;
  readonly deleteGitRepository: (id: RepositoryId) => Effect.Effect<void, NotFound>;
}

interface ThreadRow {
  id: string;
  title: string;
  sdk_session_id: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
}
interface ThreadSourceRow {
  thread_id: string;
  source_kind: "database" | "git";
  source_id: string;
  position: number;
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
  connection_id: string | null;
  message_id: string | null;
  sql: string;
  row_estimate: number | null;
  status: string;
  result_json: string | null;
  created_at: string;
  resolved_at: string | null;
}
interface GitRepositoryRow {
  id: string;
  name: string;
  path: string;
  branch: string;
  head_commit: string;
  created_at: string;
  updated_at: string;
}

const toSource = (row: ThreadSourceRow): SourceRef =>
  row.source_kind === "database"
    ? { kind: "database", id: row.source_id as ConnectionId }
    : { kind: "git", id: row.source_id as RepositoryId };

const toThread = (row: ThreadRow, sources: ReadonlyArray<SourceRef>): Thread => ({
  id: row.id as ThreadId,
  sources,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.sdk_session_id ? { sdkSessionId: row.sdk_session_id } : {}),
  ...(row.model ? { model: row.model } : {}),
});

const safeParseParts = (json: string): ReadonlyArray<MessagePart> => {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? (value as ReadonlyArray<MessagePart>) : [];
  } catch {
    return [];
  }
};

const toMessage = (row: MessageRow): Message => ({
  id: row.id as MessageId,
  threadId: row.thread_id as ThreadId,
  role: row.role as MessageRole,
  parts: safeParseParts(row.parts_json),
  createdAt: row.created_at,
});

const toApproval = (row: ApprovalDbRow): ApprovalRow => ({
  id: row.id as ApprovalId,
  threadId: row.thread_id as ThreadId,
  connectionId: (row.connection_id ?? undefined) as ConnectionId | undefined,
  messageId: (row.message_id ?? undefined) as MessageId | undefined,
  sql: row.sql,
  rowEstimate: row.row_estimate ?? undefined,
  status: row.status as ApprovalStatus,
  resultJson: row.result_json ?? undefined,
  createdAt: row.created_at,
  resolvedAt: row.resolved_at ?? undefined,
});

const toGitRepository = (row: GitRepositoryRow): GitRepository => ({
  id: row.id as RepositoryId,
  name: row.name,
  path: row.path,
  branch: row.branch,
  headCommit: row.head_commit,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const makeChatRepo = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = () => new Date().toISOString();

  const sourcesFor = (id: ThreadId) =>
    sql<ThreadSourceRow>`SELECT * FROM thread_sources WHERE thread_id = ${id} ORDER BY position, rowid`.pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(toSource)),
    );

  const getThread: ChatRepoShape["getThread"] = (id) =>
    Effect.gen(function* () {
      const rows = yield* sql<ThreadRow>`SELECT * FROM threads WHERE id = ${id}`.pipe(Effect.orDie);
      if (!rows[0]) return yield* Effect.fail(new NotFound({ entity: "thread", id }));
      return toThread(rows[0], yield* sourcesFor(id));
    });

  const getGitRepository: ChatRepoShape["getGitRepository"] = (id) =>
    sql<GitRepositoryRow>`SELECT * FROM git_repositories WHERE id = ${id}`.pipe(
      Effect.orDie,
      Effect.flatMap((rows) => rows[0]
        ? Effect.succeed(toGitRepository(rows[0]))
        : Effect.fail(new NotFound({ entity: "git repository", id }))),
    );

  const setThreadSources: ChatRepoShape["setThreadSources"] = (id, sources) =>
    Effect.gen(function* () {
      yield* getThread(id);
      const unique = sources.filter((source, index) =>
        sources.findIndex((candidate) => candidate.kind === source.kind && candidate.id === source.id) === index,
      );
      yield* sql`DELETE FROM thread_sources WHERE thread_id = ${id}`.pipe(Effect.orDie);
      for (const [position, source] of unique.entries()) {
        yield* sql`INSERT INTO thread_sources (thread_id, source_kind, source_id, position)
          VALUES (${id}, ${source.kind}, ${source.id}, ${position})`.pipe(Effect.orDie);
      }
      return yield* getThread(id);
    });

  const repo: ChatRepoShape = {
    listThreads: () =>
      Effect.gen(function* () {
        const rows = yield* sql<ThreadRow>`SELECT * FROM threads ORDER BY updated_at DESC`.pipe(Effect.orDie);
        const sourceRows = yield* sql<ThreadSourceRow>`SELECT * FROM thread_sources ORDER BY position, rowid`.pipe(Effect.orDie);
        const byThread = new Map<string, SourceRef[]>();
        for (const sourceRow of sourceRows) {
          const sources = byThread.get(sourceRow.thread_id) ?? [];
          sources.push(toSource(sourceRow));
          byThread.set(sourceRow.thread_id, sources);
        }
        return rows.map((row) => toThread(row, byThread.get(row.id) ?? []));
      }),
    getThread,
    createThread: (title, sources) =>
      Effect.gen(function* () {
        const thread: Thread = { id: newId("t") as ThreadId, sources: [], title, createdAt: now(), updatedAt: now() };
        yield* sql`INSERT INTO threads (id, title, created_at, updated_at)
          VALUES (${thread.id}, ${thread.title}, ${thread.createdAt}, ${thread.updatedAt})`.pipe(Effect.orDie);
        return yield* setThreadSources(thread.id, sources);
      }),
    setThreadSources,
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
    insertMessage: (message) =>
      sql`INSERT INTO messages (id, thread_id, role, parts_json, created_at)
        VALUES (${message.id}, ${message.threadId}, ${message.role}, ${JSON.stringify(message.parts)}, ${message.createdAt})`.pipe(
        Effect.orDie,
        Effect.asVoid,
      ),
    createApproval: (approval) =>
      sql`INSERT INTO approvals (id, thread_id, connection_id, message_id, sql, row_estimate, status, created_at)
        VALUES (${approval.id}, ${approval.threadId}, ${approval.connectionId}, ${approval.messageId}, ${approval.sql}, ${approval.rowEstimate ?? null}, 'pending', ${now()})`.pipe(
        Effect.orDie,
        Effect.asVoid,
      ),
    getApproval: (id) =>
      sql<ApprovalDbRow>`SELECT * FROM approvals WHERE id = ${id}`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) => rows[0]
          ? Effect.succeed(toApproval(rows[0]))
          : Effect.fail(new NotFound({ entity: "approval", id }))),
      ),
    setApprovalStatus: (id, status, result) =>
      sql`UPDATE approvals SET status = ${status}, result_json = ${result === undefined ? null : JSON.stringify(result)},
        resolved_at = ${now()} WHERE id = ${id}`.pipe(Effect.orDie, Effect.asVoid),
    listGitRepositories: () =>
      sql<GitRepositoryRow>`SELECT * FROM git_repositories ORDER BY updated_at DESC`.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map(toGitRepository)),
      ),
    getGitRepository,
    insertGitRepository: (repository) =>
      sql`INSERT INTO git_repositories (id, name, path, branch, head_commit, created_at, updated_at)
        VALUES (${repository.id}, ${repository.name}, ${repository.path}, ${repository.branch}, ${repository.headCommit}, ${repository.createdAt}, ${repository.updatedAt})`.pipe(
        Effect.orDie,
        Effect.asVoid,
      ),
    updateGitRepositoryHead: (id, branch, headCommit) =>
      sql`UPDATE git_repositories SET branch = ${branch}, head_commit = ${headCommit}, updated_at = ${now()} WHERE id = ${id}`.pipe(
        Effect.orDie,
        Effect.andThen(getGitRepository(id)),
      ),
    deleteGitRepository: (id) =>
      Effect.gen(function* () {
        yield* getGitRepository(id);
        yield* sql`DELETE FROM thread_sources WHERE source_kind = 'git' AND source_id = ${id}`.pipe(Effect.orDie);
        yield* sql`DELETE FROM git_repositories WHERE id = ${id}`.pipe(Effect.orDie);
      }),
  };
  return repo;
});
