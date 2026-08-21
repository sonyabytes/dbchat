import { randomBytes, randomUUID } from "node:crypto";

import { DBCHAT_TOOL_SPECS, type ToolResult } from "./tools.ts";

interface ToolSession {
  readonly call: (name: string, input: unknown, callId: string) => Promise<ToolResult>;
}

const sessions = new Map<string, ToolSession>();

export const registerMcpToolSession = (session: ToolSession): { token: string; close: () => void } => {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, session);
  return { token, close: () => sessions.delete(token) };
};

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };

const error = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const result = (id: RpcRequest["id"], value: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result: value });

export const handleMcpRequest = async (
  authorization: string | undefined,
  body: unknown,
): Promise<{ status: number; body?: unknown }> => {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const session = token ? sessions.get(token) : undefined;
  if (!session) return { status: 401, body: error(null, -32001, "Invalid or expired agent tool token") };
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: error(null, -32600, "Invalid request") };

  const request = body as RpcRequest;
  switch (request.method) {
    case "initialize": {
      const requested = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return {
        status: 200,
        body: result(request.id, {
          protocolVersion: typeof requested === "string" ? requested : "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "dbchat", version: "0.1.0" },
        }),
      };
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return { status: 202 };
    case "ping":
      return { status: 200, body: result(request.id, {}) };
    case "tools/list":
      return {
        status: 200,
        body: result(request.id, {
          tools: DBCHAT_TOOL_SPECS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        }),
      };
    case "tools/call": {
      const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
      if (typeof params?.name !== "string") return { status: 200, body: error(request.id, -32602, "Tool name is required") };
      const toolResult = await session.call(params.name, params.arguments ?? {}, randomUUID());
      return { status: 200, body: result(request.id, toolResult) };
    }
    default:
      return { status: 200, body: error(request.id, -32601, `Method not found: ${request.method ?? "(missing)"}`) };
  }
};
