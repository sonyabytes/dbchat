import { createFileRoute } from "@tanstack/react-router";

import { ConnectionsScreen } from "@/components/screens/connections";

export const Route = createFileRoute("/")({
  component: ConnectionsScreen,
});
