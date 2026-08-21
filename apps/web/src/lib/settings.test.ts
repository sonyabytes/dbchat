import { beforeEach, describe, expect, test } from "bun:test";

import { applyTheme, resolveTheme, toggleTheme, useSettings } from "./settings.ts";
import { useApp } from "./store.ts";

/* happy-dom's matchMedia never matches, so "system" resolves to light here. */
beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  useSettings.setState({ theme: "system", rowLimit: 500, pageSize: 100, confirmDml: true });
  useApp.setState({ dark: false });
});

describe("resolveTheme", () => {
  test("explicit prefs pass through; system follows the OS (light in tests)", () => {
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("system")).toBe("light");
  });
});

describe("applyTheme", () => {
  test("toggles the html class, color-scheme and the useApp mirror", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(useApp.getState().dark).toBe(true);

    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(useApp.getState().dark).toBe(false);
  });
});

describe("setTheme / toggleTheme", () => {
  test("setTheme persists and applies", () => {
    useSettings.getState().setTheme("dark");
    expect(useSettings.getState().theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(JSON.parse(localStorage.getItem("dbchat.settings")!).state.theme).toBe("dark");
  });

  test("toggleTheme cycles system → dark → light → dark", () => {
    toggleTheme();
    expect(useSettings.getState().theme).toBe("dark");
    toggleTheme();
    expect(useSettings.getState().theme).toBe("light");
    toggleTheme();
    expect(useSettings.getState().theme).toBe("dark");
  });
});

describe("other settings", () => {
  test("setters persist under the stable storage key", () => {
    useSettings.getState().setRowLimit(1000);
    useSettings.getState().setPageSize(200);
    useSettings.getState().setConfirmDml(false);
    useSettings.getState().setDefaultModel("claude-sonnet-5");
    const stored = JSON.parse(localStorage.getItem("dbchat.settings")!);
    expect(stored.version).toBe(1);
    expect(stored.state).toMatchObject({ rowLimit: 1000, pageSize: 200, confirmDml: false, defaultModel: "claude-sonnet-5" });
  });
});
