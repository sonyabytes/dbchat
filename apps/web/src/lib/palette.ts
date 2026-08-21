/** Command-palette open state — separate module so keybindings can drive it without importing React components. */
import { create } from "zustand";

export type PaletteMode = "all" | "tables";

interface PaletteState {
  open: boolean;
  mode: PaletteMode;
  setOpen: (open: boolean, mode?: PaletteMode) => void;
  toggle: () => void;
}

export const usePalette = create<PaletteState>((set, get) => ({
  open: false,
  mode: "all",
  setOpen: (open, mode = "all") => set({ open, mode: open ? mode : "all" }),
  toggle: () => set({ open: !get().open, mode: "all" }),
}));
