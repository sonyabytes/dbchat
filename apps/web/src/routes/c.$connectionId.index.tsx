import { createFileRoute } from "@tanstack/react-router";
import { Database } from "lucide-react";

export const Route = createFileRoute("/c/$connectionId/")({
  component: () => (
    <div className="flex h-full flex-col items-center justify-center text-ink-3">
      <Database className="mb-2 size-6" />
      <p className="text-sm">
        Open a table from the sidebar, or press <kbd className="rounded-sm bg-inset px-1 font-mono text-[11px]">⌘K</kbd>
      </p>
    </div>
  ),
});
