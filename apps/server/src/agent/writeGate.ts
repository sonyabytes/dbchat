/**
 * The only capability in the agent subsystem that can reach a driver's write
 * path. Normal tools receive `forceReadOnlyDriver`, while this executor checks
 * a fresh connection policy or a persisted approval immediately before use.
 */
import {
  type ApprovalId,
  type ColumnMeta,
  type Connection,
  type ConnectionId,
  type Thread,
  type ThreadId,
  WriteBlocked,
} from "@dbchat/contracts";
import * as Effect from "effect/Effect";

import type { Driver } from "../Services/DriverRegistry.ts";
import { classifyStatements } from "../db/classify.ts";
import type { ApprovalRow } from "./repo.ts";
import { collectQuery } from "./tools.ts";

export interface AiWriteRequest {
  readonly threadId: ThreadId;
  readonly connectionId: ConnectionId;
  readonly sql: string;
  readonly approvalId?: ApprovalId;
}

export interface AiWriteResult {
  readonly columns: ReadonlyArray<ColumnMeta>;
  readonly rows: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly truncated: boolean;
  readonly affectedRows: number | undefined;
}

export interface AiWriteGateDeps {
  readonly getThread: (id: ThreadId) => Effect.Effect<Thread, unknown>;
  readonly getApproval: (id: ApprovalId) => Effect.Effect<ApprovalRow, unknown>;
  readonly getConnection: (id: ConnectionId) => Effect.Effect<Connection, unknown>;
  readonly acquireDriver: (id: ConnectionId) => Effect.Effect<Driver, unknown>;
}

/** A model-facing driver can never turn read-only off through query options. */
export const forceReadOnlyDriver = (driver: Driver): Driver => ({
  ...driver,
  query: (sql, options) => driver.query(sql, { ...options, readOnly: true }),
});

/**
 * Builds the sole AI write executor. Authorization is granted by either:
 * - an exact, persisted approval for this thread and SQL text; or
 * - the connection-level `readOnlyForAi = false` policy.
 */
export const makeAiWriteExecutor = (deps: AiWriteGateDeps) => (request: AiWriteRequest) =>
  Effect.gen(function* () {
    const thread = yield* deps.getThread(request.threadId);
    if (!thread.sources.some((source) => source.kind === "database" && source.id === request.connectionId)) {
      return yield* Effect.fail(new WriteBlocked({
        sql: request.sql,
        reason: "the selected database is not attached to this conversation",
      }));
    }
    const connection = yield* deps.getConnection(request.connectionId);

    if (request.approvalId !== undefined) {
      const approval = yield* deps.getApproval(request.approvalId);
      if (approval.threadId !== thread.id || approval.connectionId !== request.connectionId || approval.sql !== request.sql || approval.status !== "approved") {
        return yield* Effect.fail(
          new WriteBlocked({
            sql: request.sql,
            reason: "AI write approval is missing, stale, or does not match this thread and SQL statement",
          }),
        );
      }
    } else if (connection.readOnlyForAi) {
      return yield* Effect.fail(
        new WriteBlocked({
          sql: request.sql,
          reason: "AI writes require explicit approval while Read-only for AI is enabled",
        }),
      );
    }

    const driver = yield* deps.acquireDriver(request.connectionId);
    const statements = classifyStatements(request.sql, driver.dialect);
    if (statements.length !== 1 || (statements[0]?.kind !== "write" && statements[0]?.kind !== "ddl")) {
      return yield* Effect.fail(
        new WriteBlocked({
          sql: request.sql,
          reason: "AI writes must contain exactly one INSERT, UPDATE, DELETE, or DDL statement",
        }),
      );
    }

    return yield* collectQuery(driver, request.sql, { readOnly: false, limit: 1, timeoutMs: 30_000 });
  });
