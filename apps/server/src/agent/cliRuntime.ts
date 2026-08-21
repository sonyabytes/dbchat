import { isAbsolute, resolve } from "node:path";

import type { ProviderId } from "@dbchat/contracts";

import { expandHome, findOnPath, mergedBaseEnv } from "./claudeRuntime.ts";

export interface CliRuntime {
  readonly provider: Extract<ProviderId, "openai" | "opencode">;
  readonly binary: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

const resolveBinary = (value: string | undefined, command: string, env: NodeJS.ProcessEnv): string | undefined => {
  const configured = value?.trim();
  if (!configured) return findOnPath(command, env);
  const expanded = expandHome(configured);
  return isAbsolute(expanded) || expanded.includes("/") ? resolve(expanded) : findOnPath(expanded, env);
};

export const resolveCliRuntime = (
  provider: Extract<ProviderId, "openai" | "opencode">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): CliRuntime => {
  const env = mergedBaseEnv(baseEnv);
  const command = provider === "openai" ? "codex" : "opencode";
  const configured = provider === "openai" ? env.DBCHAT_CODEX_CLI : env.DBCHAT_OPENCODE_CLI;
  return { provider, binary: resolveBinary(configured, command, env), env };
};

export const cliAvailability = (): Record<"openai" | "opencode", { binary: string | undefined }> => ({
  openai: { binary: resolveCliRuntime("openai").binary },
  opencode: { binary: resolveCliRuntime("opencode").binary },
});
