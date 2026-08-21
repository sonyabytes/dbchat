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
/** Interface scale; applied as CSS `zoom` on <html> so px-sized text scales too. */
export type FontScale = 0.85 | 0.9 | 1 | 1.1 | 1.25;
export type UiFontPreset = "inter" | "system" | "custom";
export type MonoFontPreset = "jetbrains" | "system" | "custom";

export const FONT_SCALES: ReadonlyArray<{ value: FontScale; label: string }> = [
  { value: 0.85, label: "XS" },
  { value: 0.9, label: "S" },
  { value: 1, label: "M" },
  { value: 1.1, label: "L" },
  { value: 1.25, label: "XL" },
];

interface SettingsState {
  theme: ThemePref;
  fontScale: FontScale;
  uiFont: UiFontPreset;
  /** Font family name used when `uiFont === "custom"`. */
  uiFontCustom: string;
  monoFont: MonoFontPreset;
  monoFontCustom: string;
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
  setFontScale: (n: FontScale) => void;
  setUiFont: (p: UiFontPreset, custom?: string) => void;
  setMonoFont: (p: MonoFontPreset, custom?: string) => void;
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
      fontScale: 1,
      uiFont: "inter",
      uiFontCustom: "",
      monoFont: "jetbrains",
      monoFontCustom: "",
      rowLimit: 500,
      pageSize: 100,
      confirmDml: true,
      autoTableContext: true,
      defaultModel: null,
      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },
      setFontScale: (fontScale) => {
        set({ fontScale });
        applyTypography();
      },
      setUiFont: (uiFont, custom) => {
        set(custom === undefined ? { uiFont } : { uiFont, uiFontCustom: custom });
        applyTypography();
      },
      setMonoFont: (monoFont, custom) => {
        set(custom === undefined ? { monoFont } : { monoFont, monoFontCustom: custom });
        applyTypography();
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
        if (state) {
          applyTheme(state.theme);
          applyTypography(state);
        }
      },
    },
  ),
);

/* ---------------- typography ---------------- */

const UI_FONT_STACKS: Record<Exclude<UiFontPreset, "custom">, string> = {
  inter: '"Inter Variable"',
  system: "system-ui",
};
const MONO_FONT_STACKS: Record<Exclude<MonoFontPreset, "custom">, string> = {
  jetbrains: '"JetBrains Mono Variable"',
  system: "ui-monospace",
};

/** Quote a user-typed family name so spaces/odd characters are valid CSS. */
function quoteFamily(name: string): string {
  return `"${name.trim().replace(/["\\]/g, "")}"`;
}

/**
 * Write the user's font choices into CSS variables that `index.css` puts at the
 * front of `--font-sans` / `--font-mono`, and scale the UI via `zoom`.
 */
export function applyTypography(
  s: Pick<SettingsState, "fontScale" | "uiFont" | "uiFontCustom" | "monoFont" | "monoFontCustom"> = useSettings.getState(),
): void {
  const root = document.documentElement;
  const ui = s.uiFont === "custom" ? (s.uiFontCustom.trim() ? quoteFamily(s.uiFontCustom) : UI_FONT_STACKS.inter) : UI_FONT_STACKS[s.uiFont];
  const mono =
    s.monoFont === "custom"
      ? s.monoFontCustom.trim()
        ? quoteFamily(s.monoFontCustom)
        : MONO_FONT_STACKS.jetbrains
      : MONO_FONT_STACKS[s.monoFont];
  root.style.setProperty("--user-font-sans", ui);
  root.style.setProperty("--user-font-mono", mono);
  root.style.zoom = s.fontScale === 1 ? "" : String(s.fontScale);
}

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
  applyTypography();
  const mq = media();
  mq?.addEventListener("change", () => {
    if (useSettings.getState().theme === "system") applyTheme("system");
  });
}
