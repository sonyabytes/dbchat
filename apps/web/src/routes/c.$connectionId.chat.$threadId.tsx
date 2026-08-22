import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { ChatView } from "@/components/screens/chat";
import { useRegisterTab } from "@/lib/nav";
import { tabIds, useApp } from "@/lib/store";
import { threadListQuery } from "@/rpc/chat";

interface ChatSearch {
  /** `schema.table` injected by the table view's "Ask about this table". */
  context?: string;
  /** SQL injected by the editor's "Optimise". */
  sql?: string;
}

function ChatRoute() {
  const { threadId } = Route.useParams();
  const { data: threads } = useQuery(threadListQuery);
  const existing = useApp((s) => s.tabs.find((t) => t.id === tabIds.chat(threadId)));
  const serverTitle = threads?.find((t) => t.id === threadId)?.title;
  const title = serverTitle ?? (existing?.kind === "chat" ? existing.title : "New chat");
  useRegisterTab({ id: tabIds.chat(threadId), kind: "chat", threadId, title });
  return <ChatView key={threadId} threadId={threadId} />;
}

export const Route = createFileRoute("/c/$connectionId/chat/$threadId")({
  validateSearch: (s: Record<string, unknown>): ChatSearch => ({
    ...(typeof s.context === "string" && s.context ? { context: s.context } : {}),
    ...(typeof s.sql === "string" && s.sql ? { sql: s.sql } : {}),
  }),
  component: ChatRoute,
});
