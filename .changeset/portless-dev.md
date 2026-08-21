---
"@dbchat/web": patch
"@dbchat/server": patch
---

`bun run dev` now runs web and server behind portless: `https://dbchat.localhost` / `https://dbchat-api.localhost`, with a branch prefix in git worktrees so multiple checkouts don't fight over :5173. Set `DBCHAT_NO_PORTLESS=1` for the old fixed ports.
