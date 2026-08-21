---
"@dbchat/web": patch
"@dbchat/server": patch
"@dbchat/desktop": patch
---

Reduce idle memory: lazy-load the SQL editor (CodeMirror) and chat markdown renderer, load `node-sql-parser` on first use in the server (idle RSS ~108 MB → ~56 MB), and cap the renderer V8 heap.
