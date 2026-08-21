import type {
  ColumnMeta,
  ConnectionError,
  ConnectionId,
  ConnectionInput,
  ConnectionStatus,
  ConnectionTestResult,
  DriverError,
  NotFound,
  RowsPage,
  RowsRequest,
  SchemaMeta,
  SqlError,
  TableDetail,
  WriteBlocked,
} from "@dbchat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface QueryOptions {
  readonly readOnly?: boolean;
  readonly limit?: number;
  readonly timeoutMs?: number;
}

export interface RowBatch {
  readonly columns: ReadonlyArray<ColumnMeta>;
  readonly rows: ReadonlyArray<ReadonlyArray<unknown>>;
  /**
   * Rows *changed* by a data-changing statement (INSERT / UPDATE / DELETE), as
   * reported by the server: `rowCount` on pg, `ResultSetHeader.affectedRows` on
   * mysql, `changes` on sqlite. Only set on the `readOnly: false` path — a
   * SELECT leaves it `undefined` and callers fall back to `rows.length`.
   */
  readonly affectedRows?: number | undefined;
}

/** One live database driver (per dialect). Interruption of `query` = cancel. */
export interface Driver {
  readonly dialect: "postgres" | "mysql" | "sqlite" | "bigquery";
  readonly ping: Effect.Effect<{ latencyMs: number; serverVersion?: string }, DriverError>;
  readonly introspect: Effect.Effect<ReadonlyArray<SchemaMeta>, DriverError>;
  readonly describeTable: (schema: string, table: string) => Effect.Effect<TableDetail, DriverError | NotFound>;
  readonly rows: (req: RowsRequest) => Effect.Effect<RowsPage, DriverError | SqlError>;
  readonly query: (sql: string, options?: QueryOptions) => Stream.Stream<RowBatch, DriverError | SqlError | WriteBlocked>;
  readonly explain: (sql: string) => Effect.Effect<string, DriverError | SqlError>;
  readonly close: Effect.Effect<void>;
}

export interface DriverRegistryShape {
  /** Get (or lazily open) the driver for a stored connection. */
  readonly acquire: (id: ConnectionId) => Effect.Effect<Driver, ConnectionError | DriverError | NotFound>;
  readonly release: (id: ConnectionId) => Effect.Effect<void>;
  readonly status: (id: ConnectionId) => Effect.Effect<ConnectionStatus>;
  /** Open a throwaway driver from raw input, ping it, close it. */
  readonly test: (input: ConnectionInput) => Effect.Effect<ConnectionTestResult, ConnectionError | DriverError>;
}

export class DriverRegistry extends Context.Service<DriverRegistry, DriverRegistryShape>()(
  "dbchat/Services/DriverRegistry",
) {}
