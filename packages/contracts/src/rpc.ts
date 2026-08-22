import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { ClaudeRuntimeSettings, ClaudeRuntimeStatus, ProviderModels } from "./ai.ts";
import { ApprovalResolveInput, ChatEvent, ChatSendInput, Message, Thread, ThreadCreateInput, ThreadSourcesSetInput } from "./chat.ts";
import { Connection, ConnectionCredentials, ConnectionInput, ConnectionStatus, ConnectionTestResult } from "./connection.ts";
import { AgentError, ConnectionError, DriverError, NotFound, SqlError, ValidationError, WriteBlocked } from "./errors.ts";
import { ConnectionId, QueryId, RunId, ThreadId } from "./ids.ts";
import { SchemaMeta, TableDetail } from "./schema.ts";
import {
  QueryHistoryEntry,
  SavedQuery,
  SavedQuerySaveInput,
  SqlExplainResult,
  SqlResult,
  SqlRunRequest,
  SqlSuggestRequest,
  SqlSuggestResult,
} from "./sql.ts";
import { RowsPage, RowsRequest } from "./table.ts";
import { GitHubConnectionTest, GitHubConnectionTestInput, GitRepository, GitRepositoryInput, GitRepositoryInspection } from "./source.ts";
import { RepositoryId } from "./ids.ts";

export const ServerHealth = Schema.Struct({ ok: Schema.Boolean, version: Schema.String });
export type ServerHealth = typeof ServerHealth.Type;

const ById = Schema.Struct({ id: ConnectionId });
const ByConnection = Schema.Struct({ connectionId: ConnectionId });
const ByThread = Schema.Struct({ threadId: ThreadId });

const DbErrors = Schema.Union([ConnectionError, DriverError, NotFound]);
const SqlErrors = Schema.Union([ConnectionError, DriverError, SqlError, NotFound, WriteBlocked]);

/** All RPC tags; use these constants rather than string literals on the client. */
export const RPC = {
  serverHealth: "server.health",
  connectionList: "connection.list",
  connectionCredentials: "connection.credentials",
  connectionCreate: "connection.create",
  connectionUpdate: "connection.update",
  connectionDelete: "connection.delete",
  connectionTest: "connection.test",
  connectionConnect: "connection.connect",
  connectionDisconnect: "connection.disconnect",
  schemaList: "schema.list",
  schemaTable: "schema.table",
  schemaRefresh: "schema.refresh",
  tableRows: "table.rows",
  sqlRun: "sql.run",
  sqlCancel: "sql.cancel",
  sqlExplain: "sql.explain",
  sqlHistoryList: "sql.history.list",
  sqlSavedList: "sql.saved.list",
  sqlSavedSave: "sql.saved.save",
  sqlSavedDelete: "sql.saved.delete",
  sqlSuggest: "sql.suggest",
  chatThreadsList: "chat.threads.list",
  chatThreadsCreate: "chat.threads.create",
  chatThreadsDelete: "chat.threads.delete",
  chatThreadSourcesSet: "chat.thread.sources.set",
  chatMessagesList: "chat.messages.list",
  chatSend: "chat.send",
  chatAbort: "chat.abort",
  chatApprovalResolve: "chat.approval.resolve",
  chatEvents: "chat.events",
  gitRepositoriesList: "git.repositories.list",
  gitRepositoriesCreate: "git.repositories.create",
  gitRepositoriesRefresh: "git.repositories.refresh",
  gitRepositoriesDelete: "git.repositories.delete",
  gitGithubTest: "git.github.test",
  aiModels: "ai.models",
  aiClaudeGet: "ai.claude.get",
  aiClaudeSet: "ai.claude.set",
  aiClaudeStatus: "ai.claude.status",
} as const;

export class DbchatRpcs extends RpcGroup.make(
  /* ---- server ---- */
  Rpc.make(RPC.serverHealth, { success: ServerHealth }),

  /* ---- connections ---- */
  Rpc.make(RPC.connectionList, { success: Schema.Array(Connection) }),
  Rpc.make(RPC.connectionCredentials, { payload: ById, success: ConnectionCredentials, error: NotFound }),
  Rpc.make(RPC.connectionCreate, {
    payload: ConnectionInput,
    success: Connection,
    error: Schema.Union([ValidationError, ConnectionError]),
  }),
  Rpc.make(RPC.connectionUpdate, {
    payload: Schema.Struct({ id: ConnectionId, input: ConnectionInput }),
    success: Connection,
    error: Schema.Union([ValidationError, ConnectionError, NotFound]),
  }),
  Rpc.make(RPC.connectionDelete, { payload: ById, error: NotFound }),
  Rpc.make(RPC.connectionTest, {
    payload: Schema.Struct({ id: Schema.optional(ConnectionId), input: ConnectionInput }),
    success: ConnectionTestResult,
    error: Schema.Union([ValidationError, ConnectionError, DriverError]),
  }),
  Rpc.make(RPC.connectionConnect, { payload: ById, success: ConnectionStatus, error: DbErrors }),
  Rpc.make(RPC.connectionDisconnect, { payload: ById, error: NotFound }),

  /* ---- schema ---- */
  Rpc.make(RPC.schemaList, { payload: ByConnection, success: Schema.Array(SchemaMeta), error: DbErrors }),
  Rpc.make(RPC.schemaTable, {
    payload: Schema.Struct({ connectionId: ConnectionId, schema: Schema.String, table: Schema.String }),
    success: TableDetail,
    error: DbErrors,
  }),
  Rpc.make(RPC.schemaRefresh, { payload: ByConnection, success: Schema.Array(SchemaMeta), error: DbErrors }),

  /* ---- table ---- */
  Rpc.make(RPC.tableRows, { payload: RowsRequest, success: RowsPage, error: SqlErrors }),

  /* ---- sql ---- */
  Rpc.make(RPC.sqlRun, { payload: SqlRunRequest, success: SqlResult, error: SqlErrors }),
  Rpc.make(RPC.sqlCancel, { payload: Schema.Struct({ runId: RunId }), error: NotFound }),
  Rpc.make(RPC.sqlExplain, { payload: SqlRunRequest, success: SqlExplainResult, error: SqlErrors }),
  Rpc.make(RPC.sqlHistoryList, { payload: ByConnection, success: Schema.Array(QueryHistoryEntry) }),
  Rpc.make(RPC.sqlSavedList, { payload: ByConnection, success: Schema.Array(SavedQuery) }),
  Rpc.make(RPC.sqlSavedSave, { payload: SavedQuerySaveInput, success: SavedQuery, error: ValidationError }),
  Rpc.make(RPC.sqlSavedDelete, { payload: Schema.Struct({ id: QueryId }), error: NotFound }),
  Rpc.make(RPC.sqlSuggest, { payload: SqlSuggestRequest, success: SqlSuggestResult, error: AgentError }),

  /* ---- chat ---- */
  Rpc.make(RPC.chatThreadsList, { success: Schema.Array(Thread) }),
  Rpc.make(RPC.chatThreadsCreate, { payload: ThreadCreateInput, success: Thread, error: NotFound }),
  Rpc.make(RPC.chatThreadsDelete, { payload: ByThread, error: NotFound }),
  Rpc.make(RPC.chatThreadSourcesSet, { payload: ThreadSourcesSetInput, success: Thread, error: NotFound }),
  Rpc.make(RPC.chatMessagesList, { payload: ByThread, success: Schema.Array(Message), error: NotFound }),
  Rpc.make(RPC.chatSend, {
    payload: ChatSendInput,
    success: ChatEvent,
    error: Schema.Union([NotFound, AgentError, WriteBlocked]),
    stream: true,
  }),
  Rpc.make(RPC.chatAbort, { payload: ByThread, error: NotFound }),
  Rpc.make(RPC.chatApprovalResolve, {
    payload: ApprovalResolveInput,
    error: Schema.Union([NotFound, SqlError, WriteBlocked]),
  }),
  Rpc.make(RPC.chatEvents, {
    payload: ByThread,
    success: ChatEvent,
    error: NotFound,
    stream: true,
  }),

  /* ---- Git context sources ---- */
  Rpc.make(RPC.gitRepositoriesList, { success: Schema.Array(GitRepository) }),
  Rpc.make(RPC.gitRepositoriesCreate, {
    payload: GitRepositoryInput,
    success: GitRepositoryInspection,
    error: ValidationError,
  }),
  Rpc.make(RPC.gitRepositoriesRefresh, {
    payload: Schema.Struct({ id: RepositoryId }),
    success: GitRepositoryInspection,
    error: Schema.Union([NotFound, ValidationError]),
  }),
  Rpc.make(RPC.gitRepositoriesDelete, { payload: Schema.Struct({ id: RepositoryId }), error: NotFound }),
  Rpc.make(RPC.gitGithubTest, {
    payload: GitHubConnectionTestInput,
    success: GitHubConnectionTest,
    error: ValidationError,
  }),

  /* ---- ai ---- */
  Rpc.make(RPC.aiModels, { success: Schema.Array(ProviderModels) }),
  Rpc.make(RPC.aiClaudeGet, { success: ClaudeRuntimeSettings }),
  Rpc.make(RPC.aiClaudeSet, { payload: ClaudeRuntimeSettings, success: ClaudeRuntimeSettings }),
  /** Probes `claude auth status` with the given (unsaved) settings, or the saved ones when omitted. */
  Rpc.make(RPC.aiClaudeStatus, { payload: Schema.optional(ClaudeRuntimeSettings), success: ClaudeRuntimeStatus }),
) {}

export type RpcTag = keyof typeof RPC extends infer K ? (K extends keyof typeof RPC ? (typeof RPC)[K] : never) : never;
