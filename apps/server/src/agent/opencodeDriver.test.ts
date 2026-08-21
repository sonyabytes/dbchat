import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startOpenCodeTurn } from "./opencodeDriver.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("OpenCode driver injects its MCP config and consumes JSON events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dbchat-opencode-test-"));
  dirs.push(dir);
  const binary = join(dir, "fake-opencode");
  writeFileSync(binary, `#!/usr/bin/env bun
const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
if (!cfg.mcp?.dbchat?.headers?.Authorization || cfg.permission?.["dbchat_*"] !== "allow") process.exit(2);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "step_start", sessionID: "ses_test", part: { type: "step-start" } });
send({ type: "reasoning", sessionID: "ses_test", part: { type: "reasoning", text: "thinking" } });
send({ type: "text", sessionID: "ses_test", part: { type: "text", text: "answer" } });
send({ type: "step_finish", sessionID: "ses_test", part: { type: "step-finish", cost: 0.01, tokens: { input: 7, output: 4, cache: { read: 2, write: 0 } } } });
`);
  chmodSync(binary, 0o755);

  const events: string[] = [];
  const handle = startOpenCodeTurn({
    binary,
    env: process.env,
    model: "opencode/big-pickle",
    cwd: dir,
    serverUrl: "http://127.0.0.1:4800",
    systemPrompt: "system",
    userPrompt: "question",
    callbacks: {
      onSession: async (id) => { events.push(`session:${id}`); },
      onText: async (text) => { events.push(`text:${text}`); },
      onThinking: async (text) => { events.push(`thinking:${text}`); },
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    },
  });
  expect(await handle.done).toEqual({ usage: { inputTokens: 9, outputTokens: 4, costUsd: 0.01 } });
  expect(events).toEqual(["session:ses_test", "thinking:thinking", "text:answer"]);
});
