/** ai.* RPC helpers — the model catalog, grouped by provider. */
import type { ClaudeRuntimeSettings, ModelInfo, ProviderModels } from "@dbchat/contracts";
import { RPC } from "@dbchat/contracts";
import { queryOptions } from "@tanstack/react-query";

import { callRpc } from "./client";

export const modelsQuery = queryOptions({
  queryKey: ["ai.models"],
  queryFn: () => callRpc((c) => c[RPC.aiModels]()),
  // The catalog is static per server process; no point refetching on focus.
  staleTime: 5 * 60_000,
});

export const allModels = (catalog: ReadonlyArray<ProviderModels> | undefined): ReadonlyArray<ModelInfo> =>
  (catalog ?? []).flatMap((p) => p.models);

export const findModel = (
  catalog: ReadonlyArray<ProviderModels> | undefined,
  id: string | null | undefined,
): ModelInfo | undefined => (id ? allModels(catalog).find((m) => m.id === id) : undefined);

/** The model the server marked as its default (`DBCHAT_MODEL`). */
export const catalogDefaultModel = (catalog: ReadonlyArray<ProviderModels> | undefined): ModelInfo | undefined =>
  allModels(catalog).find((m) => m.default);

/**
 * What the picker shows for a thread: an in-session override, then the model
 * the thread last ran on, then the user's default, then the server's.
 */
export const resolveSelectedModel = (
  catalog: ReadonlyArray<ProviderModels> | undefined,
  candidates: ReadonlyArray<string | null | undefined>,
): ModelInfo | undefined => {
  const readyIds = new Set((catalog ?? []).filter((provider) => provider.status === "ready").flatMap((provider) => provider.models.map((model) => model.id)));
  for (const id of candidates) {
    const found = findModel(catalog, id);
    if (found && readyIds.has(found.id)) return found;
  }
  const serverDefault = catalogDefaultModel(catalog);
  if (serverDefault && readyIds.has(serverDefault.id)) return serverDefault;
  return allModels(catalog).find((model) => readyIds.has(model.id));
};

/** Short label for a model id, falling back to the raw id for unknown ones. */
export const modelLabel = (
  catalog: ReadonlyArray<ProviderModels> | undefined,
  id: string | null | undefined,
): string | undefined => (id ? (findModel(catalog, id)?.label ?? id) : undefined);

/* ---- Claude runtime (binary / config dir / login probe) ---- */

export const claudeSettingsQuery = queryOptions({
  queryKey: ["ai.claude.get"],
  queryFn: () => callRpc((c) => c[RPC.aiClaudeGet]()),
});

export const saveClaudeSettings = (settings: ClaudeRuntimeSettings) => callRpc((c) => c[RPC.aiClaudeSet](settings));

/** Probe with unsaved settings (or the saved ones when omitted). */
export const probeClaudeStatus = (settings?: ClaudeRuntimeSettings) =>
  callRpc((c) => c[RPC.aiClaudeStatus](settings));
