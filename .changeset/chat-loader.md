---
"@dbchat/web": patch
---

Fix chat loading state: replace the boxed "Working…" card with an inline spinner + shimmer loader, and keep the loader visible after the first tool call until text streams in.
