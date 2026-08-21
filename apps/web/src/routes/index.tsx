import { createFileRoute } from "@tanstack/react-router";

import { HomeWorkspace } from "@/components/home-workspace";
import { ChatView } from "@/components/screens/chat";

function HomeRoute() {
  return <HomeWorkspace><ChatView threadId="home" /></HomeWorkspace>;
}

export const Route = createFileRoute("/")({ component: HomeRoute });
