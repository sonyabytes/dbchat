import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { HomeWorkspace } from "@/components/home-workspace";
import { ChatView } from "@/components/screens/chat";
import { useRegisterTab } from "@/lib/nav";
import { tabIds, useApp } from "@/lib/store";
import { threadListQuery } from "@/rpc/chat";

interface ChatSearch {
  context?: string;
  sql?: string;
}

function GlobalChatRoute() {
  const { threadId } = Route.useParams();
  const { data: threads } = useQuery(threadListQuery);
  const existing = useApp((state) => state.workspaces.global?.tabs.find((tab) => tab.id === tabIds.chat(threadId)));
  const title = threads?.find((thread) => thread.id === threadId)?.title ?? (existing?.kind === "chat" ? existing.title : "New chat");
  useRegisterTab({ id: tabIds.chat(threadId), kind: "chat", threadId, title });
  return <HomeWorkspace><ChatView key={threadId} threadId={threadId} /></HomeWorkspace>;
}

export const Route = createFileRoute("/chat/$threadId")({
  validateSearch: (search: Record<string, unknown>): ChatSearch => ({
    ...(typeof search.context === "string" && search.context ? { context: search.context } : {}),
    ...(typeof search.sql === "string" && search.sql ? { sql: search.sql } : {}),
  }),
  component: GlobalChatRoute,
});
