/**
 * table.rows binding — server-side pagination / sort / filter.
 *
 * Paging is offset-based (`offset` + `limit`); `RowsPage.total` drives the footer.
 * Sort and filters are sent verbatim from the toolbar state, so the query key
 * carries them and react-query keeps the previous page visible while refetching.
 */
import type { ConnectionId, FilterSpec, RowsRequest, SortSpec } from "@dbchat/contracts";
import { RPC } from "@dbchat/contracts";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { callRpc } from "./client";

export const PAGE_SIZE = 100;

export interface TableRowsParams {
  connectionId: ConnectionId;
  schema: string;
  table: string;
  offset: number;
  limit?: number;
  sort?: ReadonlyArray<SortSpec>;
  filters?: ReadonlyArray<FilterSpec>;
}

export const tableRowsQuery = (p: TableRowsParams) => {
  const request: RowsRequest = {
    connectionId: p.connectionId,
    schema: p.schema,
    table: p.table,
    offset: p.offset,
    limit: p.limit ?? PAGE_SIZE,
    ...(p.sort && p.sort.length > 0 ? { sort: p.sort } : {}),
    ...(p.filters && p.filters.length > 0 ? { filters: p.filters } : {}),
  };
  return queryOptions({
    queryKey: [
      "table.rows",
      request.connectionId,
      request.schema,
      request.table,
      request.offset,
      request.limit,
      request.sort ?? null,
      request.filters ?? null,
    ],
    queryFn: ({ signal }) => callRpc((c) => c[RPC.tableRows](request), { signal }),
    placeholderData: keepPreviousData,
    retry: false,
  });
};
