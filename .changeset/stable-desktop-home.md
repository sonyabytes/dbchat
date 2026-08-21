---
"@dbchat/desktop": patch
---

Desktop app now stores its sqlite database and key in `~/.dbchat` (or `DBCHAT_HOME`), the same location as the dev server, so chat history survives reinstalls and is shared between dev and packaged builds.
