import { spawn } from "node:child_process";
import readline from "node:readline";

import type { Usage } from "@dbchat/contracts";

import type { AgentDriverTurn, AgentTurnHandle, AgentTurnOutcome } from "./driver.ts";
import { registerMcpToolSession } from "./mcpBridge.ts";

type JsonObject = Record<string, unknown>;

const existingInlineConfig = (raw: string | undefined): JsonObject => {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
  } catch {
    return {};
  }
};

/** OpenCode CLI driver using JSON events and a turn-scoped remote MCP server. */
export const startOpenCodeTurn = (args: AgentDriverTurn): AgentTurnHandle => {
  if (!args.serverUrl) {
    return { interrupt: async () => undefined, done: Promise.resolve({ error: "OpenCode driver is missing the dbchat server URL" }) };
  }

  const mcp = registerMcpToolSession({ call: args.callbacks.callTool });
  const prior = existingInlineConfig(args.env.OPENCODE_CONFIG_CONTENT);
  const config = {
    ...prior,
    permission: { "*": "deny", "dbchat_*": "allow" },
    mcp: {
      ...(prior.mcp && typeof prior.mcp === "object" && !Array.isArray(prior.mcp) ? prior.mcp as JsonObject : {}),
      dbchat: {
        type: "remote",
        url: `${args.serverUrl}/agent/mcp`,
        headers: { Authorization: `Bearer ${mcp.token}` },
      },
    },
    agent: {
      ...(prior.agent && typeof prior.agent === "object" && !Array.isArray(prior.agent) ? prior.agent as JsonObject : {}),
      dbchat: {
        description: "dbchat database assistant",
        mode: "primary",
        prompt: `${args.systemPrompt}\n\nOnly use the dbchat MCP tools. Do not use shell, filesystem, web, skills, or subagents.`,
        permission: { "*": "deny", "dbchat_*": "allow" },
      },
    },
  };
  const cliArgs = ["run", "--format", "json", "--model", args.model, "--agent", "dbchat", "--dir", args.cwd];
  if (args.sessionId) cliArgs.push("--session", args.sessionId);
  cliArgs.push(args.userPrompt);

  const child = spawn(args.binary, cliArgs, {
    cwd: args.cwd,
    env: {
      ...args.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = readline.createInterface({ input: child.stdout! });
  let settled = false;
  let sessionId: string | undefined;
  let providerError: string | undefined;
  let usage: Usage | undefined;
  let costUsd = 0;
  let callbackChain = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => { callbackChain = callbackChain.then(task, task); };
  let finish!: (outcome: AgentTurnOutcome) => void;
  const completed = new Promise<AgentTurnOutcome>((resolve) => { finish = resolve; });
  const end = (outcome: AgentTurnOutcome) => {
    if (settled) return;
    settled = true;
    void callbackChain.finally(() => {
      mcp.close();
      lines.close();
      finish(outcome);
    });
  };

  lines.on("line", (line) => {
    let event: JsonObject;
    try { event = JSON.parse(line) as JsonObject; } catch { return; }
    if (!sessionId && typeof event.sessionID === "string") {
      sessionId = event.sessionID;
      enqueue(() => args.callbacks.onSession(sessionId!));
    }
    const part = event.part as JsonObject | undefined;
    if (event.type === "text" && typeof part?.text === "string") {
      enqueue(() => args.callbacks.onText(String(part.text)));
    } else if (event.type === "reasoning" && typeof part?.text === "string") {
      enqueue(() => args.callbacks.onThinking(String(part.text)));
    } else if (event.type === "step_finish" && part) {
      const tokens = part.tokens as JsonObject | undefined;
      if (tokens) {
        const previous = usage ?? { inputTokens: 0, outputTokens: 0 };
        usage = {
          inputTokens: previous.inputTokens + Number(tokens.input ?? 0) + Number((tokens.cache as JsonObject | undefined)?.read ?? 0),
          outputTokens: previous.outputTokens + Number(tokens.output ?? 0),
        };
      }
      costUsd += Number(part.cost ?? 0);
    } else if (event.type === "error") {
      const error = event.error as JsonObject | undefined;
      const data = error?.data as JsonObject | undefined;
      providerError = String(data?.message ?? error?.message ?? error?.name ?? "OpenCode turn failed");
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (process.env.DBCHAT_AGENT_DEBUG) console.error("[opencode]", chunk.toString().trimEnd());
  });
  child.on("error", (error) => end({ error: `Could not start OpenCode: ${error.message}` }));
  child.on("exit", (code, signal) => {
    const finalUsage = usage ? { ...usage, ...(costUsd > 0 ? { costUsd } : {}) } : undefined;
    end({
      ...(finalUsage ? { usage: finalUsage } : {}),
      ...(providerError || code !== 0 ? { error: providerError ?? `OpenCode exited (${code ?? signal ?? "unknown"})` } : {}),
    });
  });

  return {
    done: completed,
    interrupt: async () => {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
};
