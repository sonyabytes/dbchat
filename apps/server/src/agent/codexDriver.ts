import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import type { Usage } from "@dbchat/contracts";

import type { AgentDriverTurn, AgentTurnHandle, AgentTurnOutcome } from "./driver.ts";
import { DBCHAT_TOOL_SPECS } from "./tools.ts";

type JsonObject = Record<string, unknown>;
type Pending = { resolve: (value: JsonObject) => void; reject: (error: Error) => void };

const message = (value: unknown): string => value instanceof Error ? value.message : String(value);

/** Codex app-server driver over its documented stdio JSONL transport. */
export const startCodexTurn = (args: AgentDriverTurn): AgentTurnHandle => {
  const child = spawn(args.binary, ["app-server", "--stdio"], {
    cwd: args.cwd,
    env: args.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, Pending>();
  let requestId = 0;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let settled = false;
  let lastUsage: Usage | undefined;
  let providerError: string | undefined;

  let finish!: (outcome: AgentTurnOutcome) => void;
  const completed = new Promise<AgentTurnOutcome>((resolve) => { finish = resolve; });
  let callbackChain = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => { callbackChain = callbackChain.then(task, task); };

  const send = (value: unknown) => {
    if (child.stdin.destroyed) throw new Error("Codex app-server stdin is closed");
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const request = (method: string, params: unknown): Promise<JsonObject> => {
    const id = ++requestId;
    return new Promise<JsonObject>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ method, id, params });
    });
  };
  const end = (outcome: AgentTurnOutcome) => {
    if (settled) return;
    settled = true;
    void callbackChain.finally(() => {
      finish(outcome);
      lines.close();
      if (!child.killed) child.kill();
    });
  };

  lines.on("line", (line) => {
    let value: JsonObject;
    try { value = JSON.parse(line) as JsonObject; } catch { return; }
    const id = typeof value.id === "number" ? value.id : undefined;

    if (id !== undefined && typeof value.method !== "string") {
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      if (value.error && typeof value.error === "object") {
        waiter.reject(new Error(String((value.error as JsonObject).message ?? "Codex request failed")));
      } else {
        waiter.resolve((value.result as JsonObject | undefined) ?? {});
      }
      return;
    }

    if (value.method === "item/tool/call" && id !== undefined) {
      const params = (value.params as JsonObject | undefined) ?? {};
      const name = String(params.tool ?? "");
      const callId = String(params.callId ?? id);
      enqueue(async () => {
        try {
          const toolResult = await args.callbacks.callTool(name, params.arguments ?? {}, callId);
          send({
            id,
            result: {
              contentItems: toolResult.content.map((item) => ({ type: "inputText", text: item.text })),
              success: toolResult.isError !== true,
            },
          });
        } catch (error) {
          send({ id, result: { contentItems: [{ type: "inputText", text: message(error) }], success: false } });
        }
      });
      return;
    }

    const params = (value.params as JsonObject | undefined) ?? {};
    if (value.method === "turn/started") {
      const turn = params.turn as JsonObject | undefined;
      if (turn?.id) turnId = String(turn.id);
    } else if (value.method === "item/agentMessage/delta" && params.delta) {
      enqueue(() => args.callbacks.onText(String(params.delta)));
    } else if (value.method === "item/reasoning/summaryTextDelta" && params.delta) {
      enqueue(() => args.callbacks.onThinking(String(params.delta)));
    } else if (value.method === "thread/tokenUsage/updated") {
      const tokenUsage = params.tokenUsage as JsonObject | undefined;
      const last = tokenUsage?.last as JsonObject | undefined;
      if (last) {
        lastUsage = { inputTokens: Number(last.inputTokens ?? 0) + Number(last.cachedInputTokens ?? 0), outputTokens: Number(last.outputTokens ?? 0) };
      }
    } else if (value.method === "error") {
      const error = params.error as JsonObject | undefined;
      providerError = String(error?.message ?? params.message ?? "Codex turn failed");
    } else if (value.method === "turn/completed") {
      const turn = params.turn as JsonObject | undefined;
      const error = turn?.error as JsonObject | undefined;
      const status = String(turn?.status ?? "completed");
      end({
        ...(lastUsage ? { usage: lastUsage } : {}),
        ...(providerError || status === "failed" ? { error: providerError ?? String(error?.message ?? "Codex turn failed") } : {}),
      });
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    if (process.env.DBCHAT_AGENT_DEBUG) console.error("[codex]", chunk.toString().trimEnd());
  });
  child.on("error", (error) => end({ error: `Could not start Codex: ${error.message}` }));
  child.on("exit", (code, signal) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
    pending.clear();
    if (!settled) end({ ...(lastUsage ? { usage: lastUsage } : {}), error: providerError ?? `Codex app-server exited before completing (${code ?? signal ?? "unknown"})` });
  });

  void (async () => {
    try {
      await request("initialize", {
        clientInfo: { name: "dbchat", title: "dbchat", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      send({ method: "initialized", params: {} });

      const common = {
        model: args.model,
        cwd: args.cwd,
        approvalPolicy: "never",
        sandbox: "readOnly",
        baseInstructions: `${args.systemPrompt}\n\nOnly use the dbchat dynamic tools. Do not use shell, filesystem, web, skills, or subagents.`,
      };
      let result: JsonObject;
      if (args.sessionId) {
        try {
          result = await request("thread/resume", { threadId: args.sessionId, ...common });
        } catch {
          result = await request("thread/start", {
            ...common,
            dynamicTools: DBCHAT_TOOL_SPECS.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
          });
        }
      } else {
        result = await request("thread/start", {
          ...common,
          dynamicTools: DBCHAT_TOOL_SPECS.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        });
      }
      const thread = result.thread as JsonObject | undefined;
      if (!thread?.id) throw new Error("Codex did not return a thread id");
      threadId = String(thread.id);
      await args.callbacks.onSession(threadId);
      await request("turn/start", {
        threadId,
        input: [{ type: "text", text: args.userPrompt }],
        sandboxPolicy: {
          type: "readOnly",
          networkAccess: false,
        },
      });
    } catch (error) {
      end({ error: `Codex failed: ${message(error)}` });
    }
  })();

  return {
    done: completed,
    interrupt: async () => {
      if (threadId && turnId && !settled) {
        try { await request("turn/interrupt", { threadId, turnId }); } catch { /* process shutdown below is the fallback */ }
      }
      if (!child.killed) child.kill("SIGTERM");
    },
  };
};
