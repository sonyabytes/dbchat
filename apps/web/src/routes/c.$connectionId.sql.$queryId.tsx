import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { useRegisterTab } from "@/lib/nav";
import { tabIds, useApp } from "@/lib/store";
import { savedQueriesQuery } from "@/rpc/sql";

// CodeMirror is ~340 kB of JS; only pay for it (parse + heap) once a SQL tab is opened.
const SqlEditor = lazy(() => import("@/components/screens/sql-editor").then((m) => ({ default: m.SqlEditor })));

interface SqlSearch {
  /** Prefilled SQL — used by chat's "open in editor". */
  sql?: string;
}

function SqlRoute() {
  const { connectionId, queryId } = Route.useParams();
  const { data: saved } = useQuery(savedQueriesQuery(connectionId));
  const existing = useApp((s) => s.tabs.find((t) => t.id === tabIds.sql(queryId)));
  const savedName = saved?.find((s) => s.id === queryId)?.name;
  const title = savedName
    ? `${savedName}.sql`
    : existing?.kind === "sql"
      ? existing.title
      : queryId === "new"
        ? "untitled.sql"
        : `${queryId}.sql`;
  useRegisterTab({ id: tabIds.sql(queryId), kind: "sql", queryId, title });
  return (
    <Suspense fallback={<Skeleton className="m-3 h-full" />}>
      <SqlEditor key={`${connectionId}:${queryId}`} queryId={queryId} />
    </Suspense>
  );
}

export const Route = createFileRoute("/c/$connectionId/sql/$queryId")({
  validateSearch: (s: Record<string, unknown>): SqlSearch => ({
    ...(typeof s.sql === "string" && s.sql ? { sql: s.sql } : {}),
  }),
  component: SqlRoute,
});
