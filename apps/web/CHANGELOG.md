# @dbchat/web

## 0.4.0

### Minor Changes

- 6b918ec: Add a right-click context menu on chat threads in the sidebar (Open, Copy title, Close tab, Delete) using the shadcn `context-menu` component.
- d706ce8: Replace the sidebar "Check for updates" button with a single status icon. Hover shows the version diff and release notes; click downloads the update, then the icon switches to "restart to install". Background update checks no longer pop a dialog — they just light up the icon.

### Patch Changes

- a76b6b6: Fix chat loading state: replace the boxed "Working…" card with an inline spinner + shimmer loader, and keep the loader visible after the first tool call until text streams in.
- 32ce49d: Settings → Providers now keeps a default model per provider. Picking Codex no longer shows the Anthropic server default (Sonnet 5); each provider card lists only its own models, and a "Use for new chats" button chooses which provider new chats start on.
- d706ce8: `bun run dev` now runs web and server behind portless: `https://dbchat.localhost` / `https://dbchat-api.localhost`, with a branch prefix in git worktrees so multiple checkouts don't fight over :5173. Set `DBCHAT_NO_PORTLESS=1` for the old fixed ports.
- @dbchat/contracts@0.4.0

## 0.3.0

### Minor Changes

- 8a23133: Add font customization to Settings → Appearance: interface font (Inter / System / custom), code font (JetBrains Mono / System / custom), and a font size scale (XS–XL). Choices persist in localStorage alongside the theme.

### Patch Changes

- 1501902: Reduce idle memory: lazy-load the SQL editor (CodeMirror) and chat markdown renderer, load `node-sql-parser` on first use in the server (idle RSS ~108 MB → ~56 MB), and cap the renderer V8 heap.
- @dbchat/contracts@0.3.0

## 0.2.0

### Minor Changes

- 3a7d683: Split settings into focused sections, add Codex and OpenCode to the provider catalog, and introduce searchable model selectors grouped by provider.
  
  Codex and OpenCode remain visibly unavailable until their execution runtimes are configured, and the server now rejects model selections from unavailable providers.
- 7bf83ec: Add Google BigQuery as a supported database, including sandbox-friendly Application Default Credentials, optional encrypted service-account credentials, dataset and table introspection, table browsing, queries, DML row counts, dry-run explain output, and cancellation.
  
  Add a BigQuery connection option with project and location fields, Standard SQL editor support, dialect-aware validation and quoting, and safe credential handling when switching database types.
- a9c19d7: Add functional Codex and OpenCode agent drivers with CLI runtime discovery, streaming responses, resumable provider sessions, and the same guarded database tools and write-approval flow used by Claude.
  
  Codex connects through app-server dynamic tools, while OpenCode uses a turn-scoped authenticated MCP bridge. Provider models become selectable automatically when their CLI is installed and configured.

### Patch Changes

- Updated dependencies [3a7d683]
- Updated dependencies [7bf83ec]
  - @dbchat/contracts@0.2.0

## 0.1.3

### Patch Changes

- @dbchat/contracts@0.1.3

## 0.1.2

### Patch Changes

- 7db310f: Add a visible in-app update checker to the workspace sidebar and enlarge the sidebar footer controls.
- 3e2173e: Keep each database connection's open tabs and unsaved SQL drafts when switching connections or restarting the app.
- 1ebdfaf: Virtualize large command palette result lists so table search stays responsive and all tables remain searchable.
- @dbchat/contracts@0.1.2

## 0.1.1

### Patch Changes

- @dbchat/contracts@0.1.1
