import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startCodexTurn } from "./codexDriver.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("Codex driver negotiates app-server, streams events, and answers dynamic tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dbchat-codex-test-"));
  dirs.push(dir);
  const binary = join(dir, "fake-codex");
  writeFileSync(binary, `#!/usr/bin/env bun
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  if (msg.method === "thread/start") {
    if (!msg.params.dynamicTools.some((tool) => tool.name === "run_sql")) process.exit(2);
    send({ id: msg.id, result: { thread: { id: "thr_test" } } });
  }
  if (msg.method === "turn/start") {
    if (msg.params.sandboxPolicy?.type !== "readOnly" || msg.params.sandboxPolicy?.networkAccess !== false) process.exit(4);
    send({ id: msg.id, result: { turn: { id: "turn_test" } } });
    send({ method: "turn/started", params: { turn: { id: "turn_test" } } });
    send({ method: "item/agentMessage/delta", params: { delta: "hello" } });
    send({ method: "item/reasoning/summaryTextDelta", params: { delta: "checking" } });
    send({ method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 } } } });
    send({ id: 99, method: "item/tool/call", params: { callId: "call_1", tool: "run_sql", arguments: { sql: "select 1" } } });
  }
  if (msg.id === 99 && msg.result) {
    if (!msg.result.success) process.exit(3);
    send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    setTimeout(() => process.exit(0), 5);
  }
});
`);
  chmodSync(binary, 0o755);

  const events: string[] = [];
  const handle = startCodexTurn({
    binary,
    env: process.env,
    model: "gpt-5.3-codex",
    cwd: dir,
    systemPrompt: "system",
    userPrompt: "question",
    callbacks: {
      onSession: async (id) => { events.push(`session:${id}`); },
      onText: async (text) => { events.push(`text:${text}`); },
      onThinking: async (text) => { events.push(`thinking:${text}`); },
      callTool: async (name, input, id) => {
        events.push(`tool:${name}:${id}:${JSON.stringify(input)}`);
        return { content: [{ type: "text", text: "{\"rows\":[[1]]}" }] };
      },
    },
  });
  const outcome = await handle.done;
  expect(outcome).toEqual({ usage: { inputTokens: 12, outputTokens: 3 } });
  expect(events).toEqual([
    "session:thr_test",
    "text:hello",
    "thinking:checking",
    'tool:run_sql:call_1:{"sql":"select 1"}',
  ]);
});
