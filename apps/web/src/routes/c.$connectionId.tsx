import { createFileRoute } from "@tanstack/react-router";

import { Workspace } from "@/components/workspace";

export const Route = createFileRoute("/c/$connectionId")({
  component: Workspace,
});
