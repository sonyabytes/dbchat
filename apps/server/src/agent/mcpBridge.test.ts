import { expect, test } from "bun:test";

import { handleMcpRequest, registerMcpToolSession } from "./mcpBridge.ts";

test("turn-scoped MCP bridge lists and calls dbchat tools", async () => {
  const seen: unknown[] = [];
  const session = registerMcpToolSession({
    call: async (name, input, callId) => {
      seen.push({ name, input, callId });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    },
  });
  const auth = `Bearer ${session.token}`;
  const initialized = await handleMcpRequest(auth, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  expect(initialized.status).toBe(200);
  expect(initialized.body).toMatchObject({ result: { serverInfo: { name: "dbchat" } } });

  const listed = await handleMcpRequest(auth, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = ((listed.body as { result: { tools: Array<{ name: string }> } }).result.tools);
  expect(tools.map((tool) => tool.name)).toContain("list_schemas");

  const called = await handleMcpRequest(auth, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_sql", arguments: { sql: "select 1" } } });
  expect(called.body).toMatchObject({ result: { content: [{ text: "{\"ok\":true}" }] } });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ name: "run_sql", input: { sql: "select 1" } });

  session.close();
  expect((await handleMcpRequest(auth, { id: 4, method: "tools/list" })).status).toBe(401);
});
