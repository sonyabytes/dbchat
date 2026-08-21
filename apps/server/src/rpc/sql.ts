/**
 * `sql.*` handlers: run / cancel / explain / history / saved / suggest.
 *
 * Design notes
 * - **Cancellation.** Every `sql.run` collects its rows on a child fiber that is
 *   registered in a `RunRegistry` (see `../sql/runRegistry.ts`). `sql.cancel`
 *   interrupts that fiber; interruption propagates into the driver's row stream,
 *   which is the documented way to cancel a query (`Services/DriverRegistry.ts`).
 * - **runId.** `SqlRunRequest.runId` is optional in the contract, so when it is
 *   omitted we derive a deterministic one (`${connectionId}:${fnv1a(sql)}`) and
 *   cancel interrupts the most recent run registered under it.
 * - **History.** Every run (success, failure or cancel) is appended to
 *   `query_history`. History writes are best-effort: a persistence failure is
 *   logged, never surfaced, so it cannot fail an otherwise successful query.
 */
import {
  DbchatRpcs,
  NotFound,
  type QueryHistoryEntry,
  RPC,
  type Row,
  type SavedQuery,
  SqlError,
  type SqlResult,
  type SqlRunRequest,
  ValidationError,
} from "@dbchat/contracts";
import type { ColumnMeta } from "@dbchat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { Persistence } from "../persistence/Persistence.ts";
import { AgentService } from "../Services/AgentService.ts";
import { type Driver, DriverRegistry } from "../Services/DriverRegistry.ts";
import { makeRunRegistry } from "../sql/runRegistry.ts";
import { detectCommand, deriveRunId, isMultiStatement } from "../sql/statements.ts";
import { makeSqlStore } from "../sql/store.ts";

/** Row cap applied when the request does not carry one. */
export const DEFAULT_ROW_LIMIT = 500;
/** Hard ceiling on rows buffered for one run, whatever the client asks for. */
export const MAX_ROW_LIMIT = 10_000;
/** Wall-clock budget handed to the driver for a single run. */
export const QUERY_TIMEOUT_MS = 60_000;

const clampRowLimit = (limit: number | undefined): number =>
  limit === undefined || !Number.isFinite(limit) || limit < 1
    ? DEFAULT_ROW_LIMIT
    : Math.min(Math.trunc(limit), MAX_ROW_LIMIT);

interface Collected {
  readonly columns: ReadonlyArray<ColumnMeta>;
  readonly rows: ReadonlyArray<Row>;
  readonly truncated: boolean;
  /** Server-reported DML row count; `undefined` for a SELECT. */
  readonly affectedRows: number | undefined;
}

/** Drains the driver's batch stream into columns/rows, stopping at `limit`. */
const collect = (driver: Driver, sql: string, readOnly: boolean, limit: number) =>
  Effect.gen(function* () {
    let columns: ReadonlyArray<ColumnMeta> = [];
    const rows: Array<Row> = [];
    let dropped = false;
    let affectedRows: number | undefined;

    yield* driver.query(sql, { readOnly, limit, timeoutMs: QUERY_TIMEOUT_MS }).pipe(
      Stream.runForEachWhile((batch) =>
        Effect.sync(() => {
          if (columns.length === 0 && batch.columns.length > 0) columns = batch.columns;
          if (batch.affectedRows !== undefined) affectedRows = (affectedRows ?? 0) + batch.affectedRows;
          for (const row of batch.rows) {
            if (rows.length >= limit) {
              dropped = true;
              break;
            }
            rows.push(row);
          }
          return rows.length < limit;
        }),
      ),
    );

    return { columns, rows, truncated: dropped || rows.length >= limit, affectedRows } satisfies Collected;
  });

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause);
  if (squashed instanceof Error && squashed.message) return squashed.message;
  if (typeof squashed === "string") return squashed;
  return Cause.pretty(cause);
};

export const sqlHandlers = Effect.gen(function* () {
  const drivers = yield* DriverRegistry;
  const agent = yield* AgentService;
  const { sql: sqlClient } = yield* Persistence;

  const store = makeSqlStore(sqlClient);
  const runs = makeRunRegistry();

  /** History is never allowed to break a query; log and move on. */
  const record = (entry: Parameters<typeof store.recordRun>[0]) =>
    store.recordRun(entry).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("query_history write failed", { reason: causeMessage(cause) }),
      ),
    );

  /**
   * Defensive guard: the driver's classifier is the primary read-only gate, but
   * a `;`-separated batch must never reach it while `readOnly` is set.
   */
  const guardMultiStatement = (req: SqlRunRequest, readOnly: boolean) =>
    readOnly && isMultiStatement(req.sql)
      ? new SqlError({
          message: "Multiple statements are not allowed in read-only mode; run one statement at a time.",
          code: "MULTI_STATEMENT",
        })
      : undefined;

  const runQuery = (req: SqlRunRequest) =>
    Effect.gen(function* () {
      const readOnly = req.readOnly ?? true;
      const limit = clampRowLimit(req.limit);
      const runId = req.runId ?? deriveRunId(req.connectionId, req.sql);
      const command = detectCommand(req.sql);
      const ranAt = new Date().toISOString();
      const startedAt = Date.now();

      const failWith = (error: SqlError) =>
        record({
          connectionId: req.connectionId,
          sql: req.sql,
          durationMs: Date.now() - startedAt,
          rowCount: 0,
          ok: false,
          error: error.message,
          ranAt,
        }).pipe(Effect.andThen(Effect.fail(error)));

      const blocked = guardMultiStatement(req, readOnly);
      if (blocked) return yield* failWith(blocked);

      const driver = yield* drivers.acquire(req.connectionId);

      const fiber = yield* Effect.forkChild(collect(driver, req.sql, readOnly, limit));
      yield* runs.register(runId, fiber);
      const exit = yield* Fiber.await(fiber).pipe(Effect.ensuring(runs.unregister(runId, fiber)));
      const durationMs = Date.now() - startedAt;

      if (Exit.isSuccess(exit)) {
        const { columns, rows, truncated, affectedRows } = exit.value;
        // DML reports the rows it *changed*; a SELECT reports the rows returned.
        const rowCount = affectedRows ?? rows.length;
        yield* record({
          connectionId: req.connectionId,
          sql: req.sql,
          durationMs,
          rowCount,
          ok: true,
          ranAt,
        });
        return {
          columns,
          rows,
          rowCount,
          durationMs,
          ...(command === undefined ? {} : { command }),
          truncated,
        } satisfies SqlResult;
      }

      // Read `cause` up front: `Exit.hasInterrupts` is a type guard, so any use
      // of `exit` after it narrows to `never` in the non-interrupted branch.
      const cause = exit.cause;
      const interrupted = Exit.hasInterrupts(exit);
      const message = interrupted ? "Query canceled" : causeMessage(cause);
      yield* record({
        connectionId: req.connectionId,
        sql: req.sql,
        durationMs,
        rowCount: 0,
        ok: false,
        error: message,
        ranAt,
      });
      if (interrupted) return yield* Effect.fail(new SqlError({ message, code: "CANCELED" }));
      // Re-raise the driver's own error so `position` / `code` survive.
      return yield* Effect.failCause(cause);
    });

  return {
    [RPC.sqlRun]: (req) => runQuery(req),

    [RPC.sqlCancel]: ({ runId }) => runs.cancel(runId),

    [RPC.sqlExplain]: (req) =>
      Effect.gen(function* () {
        const blocked = guardMultiStatement(req, req.readOnly ?? true);
        if (blocked) return yield* Effect.fail(blocked);
        const driver = yield* drivers.acquire(req.connectionId);
        const plan = yield* driver.explain(req.sql);
        return { plan };
      }),

    // No error channel in the contract: a storage failure degrades to an empty list.
    [RPC.sqlHistoryList]: ({ connectionId }) =>
      store.listHistory(connectionId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("sql.history.list failed", { reason: causeMessage(cause) }).pipe(
            Effect.as([] as ReadonlyArray<QueryHistoryEntry>),
          ),
        ),
      ),

    [RPC.sqlSavedList]: ({ connectionId }) =>
      store.listSaved(connectionId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("sql.saved.list failed", { reason: causeMessage(cause) }).pipe(
            Effect.as([] as ReadonlyArray<SavedQuery>),
          ),
        ),
      ),

    // `ValidationError` is the only typed failure the contract allows here, so
    // storage errors (incl. the connection FK) are reported through it.
    [RPC.sqlSavedSave]: (input) =>
      input.name.trim().length === 0
        ? Effect.fail(new ValidationError({ field: "name", message: "Name is required" }))
        : store.saveQuery(input).pipe(
            Effect.catchTag("SqlError", (error) =>
              Effect.fail(new ValidationError({ message: `Could not save query: ${error.message}` })),
            ),
          ),

    [RPC.sqlSavedDelete]: ({ id }) =>
      store.deleteQuery(id).pipe(
        Effect.orDie,
        Effect.flatMap((deleted) =>
          deleted ? Effect.void : Effect.fail(new NotFound({ entity: "savedQuery", id })),
        ),
      ),

    [RPC.sqlSuggest]: (req) => agent.suggest(req),
  } satisfies Partial<Parameters<typeof DbchatRpcs.of>[0]>;
});
