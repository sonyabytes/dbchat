# @dbchat/web

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
