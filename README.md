# dbchat

Chat-centred SQL GUI for **Postgres, MySQL, SQLite and Google BigQuery**. Ask questions in plain language, browse
and sort tables, write SQL with AI suggestions — all against your own databases, locally. The
assistant runs through your existing **Claude Code** login; writes always go through an approval card.

> **Status:** v1, macOS arm64 desktop build + web dev mode. Unsigned build — see install notes.

## Install

### Prerequisites

| Need | Why | Check |
|---|---|---|
| [Bun](https://bun.sh) ≥ 1.3 | package manager, server runtime, desktop build | `bun --version` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) logged in | the chat assistant reuses its login — no API key needed | `claude --version`, then `claude` once to sign in |
| A database to point at | Postgres ≥ 12, MySQL ≥ 8, a SQLite file, or a BigQuery project | optional — SQLite needs nothing running; BigQuery can use ADC or service-account JSON |
| macOS 13+ on Apple Silicon | only target the desktop build ships today (web dev mode runs anywhere Bun does) | |

### Option A — Desktop app (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/sonyabytes/dbchat/main/install.sh | bash
```

Downloads the latest release DMG, installs `/Applications/dbchat.app`, clears the Gatekeeper
quarantine flag (the build is not notarized yet) and launches it. Pin a version with
`DBCHAT_VERSION=v0.1.0`, or install elsewhere with `DBCHAT_INSTALL_DIR=~/Applications`.
App data lives under `~/Library/Application Support/dbchat/` (sqlite state, encrypted credentials, logs).

Manual: grab the `.dmg` from [Releases](https://github.com/sonyabytes/dbchat/releases), drag to
Applications, then `xattr -dr com.apple.quarantine /Applications/dbchat.app` (or right-click → Open).

Build it yourself: `bun install && bun run dist:desktop` → `apps/desktop/release/dbchat-*-arm64.dmg`.

### Option B — Run from source (web)

```sh
bun install
bun run dev        # server http://127.0.0.1:4800 (ws /rpc), web http://localhost:5173
```

Open http://localhost:5173. Use this for development or on non-mac machines.

### First run

1. **New connection** → pick Postgres/MySQL/SQLite/BigQuery, enter the database details (or BigQuery project and credentials) → **Test connection** → **Save & connect**.
2. You land in a chat for that database. Try: *"which tables are largest?"* or *"top 10 customers by revenue last month"*.
3. The sidebar lists schemas/tables — click one to browse; `+` opens a new chat, SQL tab or table; `⌘K` finds anything.
4. Writes: the assistant never executes `INSERT/UPDATE/DELETE/DDL` itself — it proposes them and you approve in the chat (prod connections also require typing the connection name).

### Updating

Re-run the install one-liner (desktop), or `git pull && bun install` (source).

## Architecture

```
apps/web            Vite + React + TanStack Router + react-query (UI)
apps/server         Effect 4 on Bun: HTTP + RPC-over-WebSocket, sqlite app state, DB drivers, Claude agent
apps/desktop        Electron shell: serves apps/web/dist, supervises the server as a sidecar binary
packages/contracts  effect/Schema models + RpcGroup shared by both
```

## Development

```sh
bun run dev        # server + web with hot reload
bun run test       # server tests (bun test)
```

Other scripts: `bun run build` (contracts typecheck → server typecheck → vite build), `bun run typecheck`, `bun run test`.

Web env: `VITE_DBCHAT_RPC_URL` (`ws://127.0.0.1:4800/rpc`).


## Web

`bun run dev:web` (Vite on :5173). Routes: `/` connections, `/c/$connectionId/...` workspace
(tabs are routes: `t/$schema/$table`, `sql/$queryId`, `chat/$threadId`), `/settings`.

### Keybindings

⌘ is Ctrl on Windows/Linux. Everything except ⌘K, ⌘W and ⌘J is ignored while the SQL editor or a
text box has focus.

| Shortcut | Action |
|---|---|
| `⌘K` | Command palette — tables, chats, saved queries, connections, actions. Works on every route. |
| `⌘N` | New chat tab |
| `⌘T` | New SQL tab |
| `⌘W` | Close the current tab |
| `⌘⇧]` / `⌘⇧[` | Next / previous tab |
| `⌘J` | Toggle the right-hand chat panel |
| `⌘,` | Settings |
| `⌘↵` | Run the statement under the cursor (SQL editor) |
| `Tab` | Accept the inline SQL suggestion |

Defined in `apps/web/src/lib/keybindings.ts` (`SHORTCUTS` also feeds the Settings list).

### Settings

`/settings`, persisted to `localStorage` under `dbchat.settings` (`apps/web/src/lib/settings.ts`).
Nothing here is sent to the server.

| Setting | Values | Effect |
|---|---|---|
| Theme | `system` (default) / `light` / `dark` | Toggles the `dark` class on `<html>`; `system` tracks `prefers-color-scheme` live. |
| Default row limit | 100 / **500** / 1000 / 5000 | Initial `limit` for SQL editor runs (still overridable per tab). |
| Table page size | 50 / **100** / 200 | Rows per page in the table browser. |
| Confirm before DML | on (default) / off | Confirm dialog before running a write from the SQL editor. |
| Include current table as context | on (default) / off | Auto-attaches the open table to side-panel chat turns. |
| Default model | Server default (default) / any catalog model | Which model new chats start on. |

### Models

The server serves the catalog over `ai.models` (grouped by provider — Anthropic only today):
`claude-haiku-4-5` (fast), `claude-sonnet-5` (balanced), `claude-opus-5` (frontier). `DBCHAT_MODEL`
picks which entry is marked as the server default.

The model for a turn is `chat.send`'s `model` → the thread's last model (persisted in
`threads.model`) → `DBCHAT_MODEL`. Pick one from the picker in the prompt bar; the change applies to
the next send and sticks to the thread. Inline SQL suggestions always run on Haiku.

### Production guardrails

A connection with `env: "prod"` gets: a confirm dialog the first time it is opened in a browser
session (with "don't ask again this session"), a 2px red border along the top of the workspace,
a red `PROD` badge, an extra PRODUCTION warning on the write-approval card that requires typing the
connection name before "Run in transaction" enables, and a confirm before read-only mode can be
turned off in the SQL editor.

### Error states

The root route has an `errorComponent` (crash page with Reload) and a `notFoundComponent`. A
`server.health` poll every 5s drives the "Server unreachable — retrying…" banner; screens keep
their last data instead of throwing, and everything refetches when the server comes back.

## Server

`bun run dev:server` (watch) or `bun --filter @dbchat/server start`. Tests: `cd apps/server && bun test`.

### Environment

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4800` | HTTP + WebSocket port. |
| `HOST` | `127.0.0.1` | Bind address. |
| `DBCHAT_HOME` | `~/.dbchat` | App state directory; holds `dbchat.sqlite` (connections, threads, history, saved queries) and the encrypted secrets file. Point it at a temp dir to run a throwaway server. |
| `DBCHAT_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated origin allow-list for CORS **and** the `/rpc` WebSocket upgrade. A browser `Origin` not on the list gets `403` (so a random web page cannot drive your databases); requests with no `Origin` header (CLI/smoke scripts) pass. Add the origin you serve the web app from when it is not Vite on :5173. |
| `DBCHAT_MODEL` | `claude-sonnet-5` | Default model for chat turns; marked as the default in the `ai.models` catalog. A thread's own model, and an explicit `model` on `chat.send`, both win over it. |
| `DBCHAT_AGENT_DEBUG` | unset | Any value mirrors the agent SDK's stderr to the console. |

### Seed a local database

The local database drivers are developed against three throwaway databases. BigQuery connections use a Google Cloud project plus either Application Default Credentials or service-account JSON entered in the connection dialog.

```sh
# Postgres
createdb dbchat_dev && psql dbchat_dev -f apps/server/scripts/seed-pg.sql

# MySQL (docker)
docker run -d --name dbchat-mysql -e MYSQL_ROOT_PASSWORD=dev \
  -e MYSQL_DATABASE=dbchat_dev -p 3307:3306 mysql:8
docker exec -i dbchat-mysql mysql -uroot -pdev dbchat_dev < apps/server/scripts/seed-mysql.sql

# SQLite -> /tmp/dbchat-smoke.sqlite (override with SQLITE_PATH)
bun apps/server/scripts/seed-sqlite.ts
```

Each seed drops and recreates `users` / `orders` (+ a `paying_users` view), so re-running is safe.

### Smoke scripts

All of them talk to a **running** server over the real RPC socket; override the target with
`DBCHAT_RPC_URL` (default `ws://127.0.0.1:4800/rpc`).

```sh
bun apps/server/scripts/smoke.ts                          # server.health + connection.list + a chat turn
DBCHAT_SMOKE=postgres bun apps/server/scripts/smoke-db.ts # also: mysql | sqlite
CONNECTION_ID=c_… bun apps/server/scripts/smoke-chat.ts "top customers last 30 days"
```

`smoke-db.ts` is the end-to-end driver check: create/test/connect a connection, introspect, page rows
with sort + filter, confirm a write is blocked on the read-only path, then exercise the write path
(DDL/DML row counts, transactional rollback, result-set column types) against a scratch table.

## Desktop

Electron shell around the same web UI and server (macOS arm64 for now).

```sh
bun run dev:desktop    # server (watch) + Vite + Electron loading http://localhost:5173
bun run dist:desktop   # → apps/desktop/release/dbchat-<version>-arm64.dmg
```

How it fits together:

- `apps/server` is compiled to a standalone binary with `bun build --compile`
  (`apps/server/scripts/build-sidecar.ts` → `apps/desktop/sidecar/dbchat-server`, ~67 MB) and shipped
  in `dbchat.app/Contents/Resources/bin/`. The Claude Code CLI the Agent SDK spawns is copied next to it
  (`bin/claude`, ~320 MB) and passed to the server as `DBCHAT_CLAUDE_CLI`, because the SDK cannot
  resolve its platform package from inside a compiled binary.
- On launch the shell picks a free port and spawns the sidecar with `PORT`, `HOST=127.0.0.1`,
  `DBCHAT_HOME=<userData>/dbchat`, `DBCHAT_ALLOWED_ORIGINS=app://dbchat`, `DBCHAT_CLAUDE_CLI`; waits for
  `/health`; then loads `app://dbchat/?server=ws://127.0.0.1:<port>/rpc` (the static web build is
  served on a custom `app://` scheme so the `/rpc` Origin gate has a stable origin). The renderer also
  gets the URL via `window.dbchat.serverUrl` (preload). If the sidecar dies it is restarted up to
  3 times, then an error dialog is shown. Logs: `~/Library/Application Support/dbchat/logs/`.
- `dbchat.app --smoke --smoke-out=<png>` boots everything against a temp profile, waits for the
  connections list, writes a screenshot and exits 0 — used to verify the packaged build.
- The build is **unsigned / not notarized** (ad-hoc signature only): first launch needs
  right-click → Open, or `xattr -dr com.apple.quarantine dbchat.app`.
- The server's AES key still lives at `$DBCHAT_HOME/key`; moving it into the macOS keychain is a
  follow-up.

## License

[MIT](./LICENSE)
