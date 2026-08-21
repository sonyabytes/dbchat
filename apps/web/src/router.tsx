import { createRouter } from "@tanstack/react-router";

import { NotFoundPage, RouteErrorPage } from "./components/error-states";
import { routeTree } from "./routeTree.gen";

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultErrorComponent: ({ error, reset }) => <RouteErrorPage error={error} reset={reset} />,
  defaultNotFoundComponent: NotFoundPage,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
