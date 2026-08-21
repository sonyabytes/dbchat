import { createFileRoute } from "@tanstack/react-router";

import { TableView } from "@/components/screens/table-view";
import { useRegisterTab } from "@/lib/nav";
import { tabIds } from "@/lib/store";

function TableRoute() {
  const { schema, table } = Route.useParams();
  useRegisterTab({ id: tabIds.table(schema, table), kind: "table", schema, table });
  return <TableView key={`${schema}.${table}`} schema={schema} table={table} />;
}

export const Route = createFileRoute("/c/$connectionId/t/$schema/$table")({
  component: TableRoute,
});
