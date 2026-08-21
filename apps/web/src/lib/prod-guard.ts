/**
 * Production guardrails — session-scoped state.
 *
 * Two levels of acknowledgement, both kept in `sessionStorage` so they reset when
 * the tab is closed (a fresh session should always be warned again):
 *  - `ack`   — this connection's "you're on production" dialog was dismissed.
 *  - `mute`  — "Don't ask again this session" was ticked (applies to every prod
 *              connection for the rest of the session).
 */
import { create } from "zustand";

const ACK_KEY = "dbchat.prod.ack";
const MUTE_KEY = "dbchat.prod.mute";

function readSet(key: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeSet(key: string, value: Set<string>) {
  try {
    sessionStorage.setItem(key, JSON.stringify([...value]));
  } catch {
    /* private mode — in-memory state still works for this session */
  }
}

function readMute(): boolean {
  try {
    return sessionStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

interface ProdGuardState {
  acknowledged: Set<string>;
  muted: boolean;
  /** True when the confirm dialog should be shown for this prod connection. */
  needsConfirm: (connectionId: string) => boolean;
  acknowledge: (connectionId: string, muteSession: boolean) => void;
  reset: () => void;
}

export const useProdGuard = create<ProdGuardState>((set, get) => ({
  acknowledged: readSet(ACK_KEY),
  muted: readMute(),
  needsConfirm: (connectionId) => !get().muted && !get().acknowledged.has(connectionId),
  acknowledge: (connectionId, muteSession) => {
    const acknowledged = new Set(get().acknowledged);
    acknowledged.add(connectionId);
    writeSet(ACK_KEY, acknowledged);
    if (muteSession) {
      try {
        sessionStorage.setItem(MUTE_KEY, "1");
      } catch {
        /* ignore */
      }
    }
    set({ acknowledged, muted: get().muted || muteSession });
  },
  reset: () => {
    try {
      sessionStorage.removeItem(ACK_KEY);
      sessionStorage.removeItem(MUTE_KEY);
    } catch {
      /* ignore */
    }
    set({ acknowledged: new Set(), muted: false });
  },
}));
