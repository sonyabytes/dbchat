import type { ProviderId } from "@dbchat/contracts";

type ProviderSessions = Partial<Record<ProviderId, string>>;

/**
 * `threads.sdk_session_id` predates multiple providers. Plain legacy values are
 * Claude session ids; new values are a compact provider -> session JSON map.
 */
export const decodeProviderSessions = (stored: string | undefined): ProviderSessions => {
  if (!stored) return {};
  if (!stored.trim().startsWith("{")) return { anthropic: stored };
  try {
    const value = JSON.parse(stored) as Record<string, unknown>;
    const sessions: ProviderSessions = {};
    for (const provider of ["anthropic", "openai", "opencode"] as const) {
      if (typeof value[provider] === "string" && value[provider]) sessions[provider] = value[provider];
    }
    return sessions;
  } catch {
    return { anthropic: stored };
  }
};

export const providerSession = (stored: string | undefined, provider: ProviderId): string | undefined =>
  decodeProviderSessions(stored)[provider];

export const setProviderSession = (stored: string | undefined, provider: ProviderId, sessionId: string): string =>
  JSON.stringify({ ...decodeProviderSessions(stored), [provider]: sessionId });
