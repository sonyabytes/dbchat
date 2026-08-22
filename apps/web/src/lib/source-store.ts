import type { SourceRef } from "@dbchat/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SourceState {
  /** Sources inherited by the next draft conversation. */
  draftSources: SourceRef[];
  setDraftSources: (sources: ReadonlyArray<SourceRef>) => void;
}

export const useSources = create<SourceState>()(
  persist(
    (set) => ({
      draftSources: [],
      setDraftSources: (sources) => set({ draftSources: [...sources] }),
    }),
    { name: "dbchat.draft-sources" },
  ),
);
