/**
 * User settings — persisted to localStorage, applied app-wide.
 *
 * Theme is the only setting with a side effect: `applyTheme` toggles the `dark`
 * class on <html> and mirrors the resolved value into `useApp.dark` (CodeMirror
 * and a couple of icons read that). `initTheme()` runs once from main.tsx and
 * subscribes to the OS preference so "system" stays live.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { useApp } from "./store";

export type ThemePref = "system" | "light" | "dark";
export type RowLimit = 100 | 500 | 1000 | 5000;
export type PageSize = 50 | 100 | 200;

interface SettingsState {
  theme: ThemePref;
  /** Default LIMIT applied to SQL editor runs. */
  rowLimit: RowLimit;
  /** Rows per page in the table browser. */
  pageSize: PageSize;
  /** Ask before running INSERT/UPDATE/DELETE/DDL from the SQL editor. */
  confirmDml: boolean;
  /** Send the open table as chat context without being asked. */
  autoTableContext: boolean;
  /** Preferred model id for new chats; `null` = whatever the server defaults to. */
  defaultModel: string | null;
  setTheme: (t: ThemePref) => void;
  setRowLimit: (n: RowLimit) => void;
  setPageSize: (n: PageSize) => void;
  setConfirmDml: (v: boolean) => void;
  setAutoTableContext: (v: boolean) => void;
  setDefaultModel: (id: string | null) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      rowLimit: 500,
      pageSize: 100,
      confirmDml: true,
      autoTableContext: true,
      defaultModel: null,
      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },
      setRowLimit: (rowLimit) => set({ rowLimit }),
      setPageSize: (pageSize) => set({ pageSize }),
      setConfirmDml: (confirmDml) => set({ confirmDml }),
      setAutoTableContext: (autoTableContext) => set({ autoTableContext }),
      setDefaultModel: (defaultModel) => set({ defaultModel }),
    }),
    {
      // Stays at 1: new keys merge in from the initial state, and bumping the
      // version without a `migrate` would throw away everything already stored.
      name: "dbchat.settings",
      version: 1,
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    },
  ),
);

/* ---------------- theme ---------------- */

const media = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export function systemPrefersDark(): boolean {
  return media()?.matches ?? false;
}

export function resolveTheme(pref: ThemePref): "light" | "dark" {
  if (pref === "system") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

/** Toggle the `dark` class and mirror the result into the UI store. */
export function applyTheme(pref: ThemePref = useSettings.getState().theme): void {
  const dark = resolveTheme(pref) === "dark";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  if (useApp.getState().dark !== dark) useApp.setState({ dark });
}

/** Cycle system → light → dark → system (what the header sun/moon button does). */
export function toggleTheme(): void {
  const current = useSettings.getState().theme;
  const next: ThemePref = current === "system" ? (systemPrefersDark() ? "light" : "dark") : current === "dark" ? "light" : "dark";
  useSettings.getState().setTheme(next);
}

let themeInitialised = false;

/** Called once from main.tsx. Idempotent. */
export function initTheme(): void {
  if (themeInitialised) return;
  themeInitialised = true;
  applyTheme();
  const mq = media();
  mq?.addEventListener("change", () => {
    if (useSettings.getState().theme === "system") applyTheme("system");
  });
}
