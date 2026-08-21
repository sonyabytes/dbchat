import { Outlet, createRootRoute } from "@tanstack/react-router";

import { CommandPalette } from "@/components/command-palette";
import { NotFoundPage, RouteErrorPage } from "@/components/error-states";
import { ServerStatusBanner } from "@/components/server-status";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDocumentTitle } from "@/lib/document-title";
import { usePaletteHotkey } from "@/lib/keybindings";

function RootLayout() {
  useDocumentTitle();
  usePaletteHotkey();
  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <ServerStatusBanner />
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
      <CommandPalette />
    </TooltipProvider>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: ({ error, reset }) => <RouteErrorPage error={error} reset={reset} />,
  notFoundComponent: NotFoundPage,
});
