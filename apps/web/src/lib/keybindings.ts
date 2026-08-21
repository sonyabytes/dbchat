/**
 * Global keyboard shortcuts.
 *
 * `usePaletteHotkey()` (⌘K) is mounted by the root layout so the palette opens on
 * every route, including the connections screen and the error pages.
 * `useGlobalKeybindings()` (everything else) is mounted once by the workspace layout.
 *
 * Editing surfaces (CodeMirror, textarea, input, contenteditable) swallow every
 * binding except the three that must always work: ⌘K, ⌘W and ⌘J.
 */
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useCloseTab, useConnectionId, useOpenTab } from "./nav";
import { usePalette } from "./palette";
import { tabIds, useApp } from "./store";

export interface Shortcut {
  /** Rendered in the Settings list and the palette. */
  keys: string;
  label: string;
}

export const SHORTCUTS: ReadonlyArray<Shortcut> = [
  { keys: "⌘K", label: "Command palette" },
  { keys: "⌘N", label: "New chat" },
  { keys: "⌘T", label: "New SQL tab" },
  { keys: "⌘W", label: "Close current tab" },
  { keys: "⌘⇧]", label: "Next tab" },
  { keys: "⌘⇧[", label: "Previous tab" },
  { keys: "⌘J", label: "Toggle chat side panel" },
  { keys: "⌘,", label: "Settings" },
  { keys: "⌘↵", label: "Run SQL (editor)" },
];

/** Shortcuts that fire even when a text editor has focus. (⌘K lives in `usePaletteHotkey`.) */
const ALWAYS = new Set(["w", "j"]);

function isEditingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return true;
  return el.closest(".cm-editor") !== null;
}

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}`;

/** ⌘K only. Mounted by the root layout so the palette opens on every route. */
export function usePaletteHotkey(): void {
  const toggle = usePalette((s) => s.toggle);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
}

/** Everything except ⌘K (owned by `usePaletteHotkey`). Mount once, in the workspace layout. */
export function useGlobalKeybindings(): void {
  const navigate = useNavigate();
  const connectionId = useConnectionId();
  const openTab = useOpenTab();
  const closeTab = useCloseTab();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      const editing = isEditingTarget(e.target);

      /* ⌘⇧] / ⌘⇧[ — `e.key` is shifted on macOS, so match the physical key. */
      if (e.shiftKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
        if (editing) return;
        e.preventDefault();
        const { tabs, activeTab } = useApp.getState();
        if (tabs.length < 2) return;
        const idx = tabs.findIndex((t) => t.id === activeTab);
        const delta = e.code === "BracketRight" ? 1 : -1;
        const next = tabs[(((idx < 0 ? 0 : idx) + delta) % tabs.length + tabs.length) % tabs.length];
        if (next) openTab(next);
        return;
      }

      if (e.shiftKey) return;
      if (editing && !ALWAYS.has(key)) return;

      switch (key) {
        case "n": {
          e.preventDefault();
          const threadId = newId("new");
          openTab({ id: tabIds.chat(threadId), kind: "chat", threadId, title: "New chat" });
          return;
        }
        case "t": {
          e.preventDefault();
          const queryId = newId("draft");
          openTab({ id: tabIds.sql(queryId), kind: "sql", queryId, title: "untitled.sql" });
          return;
        }
        case "w": {
          const { activeTab } = useApp.getState();
          if (!activeTab) return;
          e.preventDefault();
          closeTab(activeTab);
          return;
        }
        case "j": {
          e.preventDefault();
          const { rightPanel, setRightPanel } = useApp.getState();
          setRightPanel(rightPanel ? null : "chat");
          return;
        }
        case ",": {
          e.preventDefault();
          void navigate({ to: "/settings" });
          return;
        }
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, connectionId, openTab, closeTab]);
}
