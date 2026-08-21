import type { Usage } from "@dbchat/contracts";

import type { ToolResult } from "./tools.ts";

export interface AgentTurnHandle {
  readonly interrupt: () => Promise<unknown>;
  readonly done: Promise<AgentTurnOutcome>;
}

export interface AgentTurnOutcome {
  readonly usage?: Usage;
  readonly error?: string;
}

export interface AgentDriverCallbacks {
  readonly onSession: (sessionId: string) => Promise<void>;
  readonly onText: (text: string) => Promise<void>;
  readonly onThinking: (text: string) => Promise<void>;
  readonly callTool: (name: string, input: unknown, callId: string) => Promise<ToolResult>;
}

export interface AgentDriverTurn {
  readonly binary: string;
  readonly env: NodeJS.ProcessEnv;
  readonly model: string;
  readonly cwd: string;
  /** Loopback dbchat HTTP origin, used by runtimes that consume remote MCP. */
  readonly serverUrl?: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly sessionId?: string;
  readonly callbacks: AgentDriverCallbacks;
}
