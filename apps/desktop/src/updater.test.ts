import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* Electron is not available under `bun test`; stub the surface updater.ts touches. */
const electron = {
  app: { isPackaged: false, getVersion: () => "1.2.3", getPath: () => "/tmp", dock: undefined as unknown },
  dialog: { showMessageBox: mock(async (_opts?: unknown) => ({ response: 2 })) },
  shell: { openExternal: mock(async () => {}) },
};
mock.module("electron", () => electron);

const { Updater, compareVersions, fetchLatestRelease, installedAppBundle, parseVersion } = await import("./updater.ts");

describe("parseVersion", () => {
  test("accepts vX.Y.Z and X.Y.Z", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("  v10.0.1 ")).toEqual([10, 0, 1]);
    expect(parseVersion("1.2.3-beta.1")).toEqual([1, 2, 3]);
  });
  test("rejects garbage", () => {
    expect(parseVersion("latest")).toBeUndefined();
    expect(parseVersion("1.2")).toBeUndefined();
    expect(parseVersion("")).toBeUndefined();
  });
});

describe("compareVersions", () => {
  test("orders numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("v2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
  });
  test("treats unparseable input as equal (never triggers an update)", () => {
    expect(compareVersions("nightly", "1.0.0")).toBe(0);
  });
});

const realExecPath = process.execPath;
const fakePackaged = (execPath = "/Applications/dbchat.app/Contents/MacOS/dbchat") => {
  electron.app.isPackaged = true;
  process.execPath = execPath;
};
const unfake = () => {
  electron.app.isPackaged = false;
  process.execPath = realExecPath;
};

describe("installedAppBundle", () => {
  afterEach(unfake);
  test("is undefined when not packaged", () => {
    unfake();
    expect(installedAppBundle()).toBeUndefined();
  });
  test.skipIf(process.platform !== "darwin")("resolves the .app bundle from the executable path", () => {
    fakePackaged();
    expect(installedAppBundle()).toBe("/Applications/dbchat.app");
  });
  test.skipIf(process.platform !== "darwin")("refuses translocated (unverified download) bundles", () => {
    fakePackaged("/private/var/folders/x/AppTranslocation/abc/d/dbchat.app/Contents/MacOS/dbchat");
    expect(installedAppBundle()).toBeUndefined();
  });
});

describe("fetchLatestRelease", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const stub = (status: number, body?: unknown) => {
    globalThis.fetch = mock(async () => new Response(body === undefined ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;
  };

  test("picks the arm64 dmg asset and normalises the tag", async () => {
    stub(200, {
      tag_name: "v1.3.0",
      html_url: "https://github.com/x/y/releases/tag/v1.3.0",
      body: "notes",
      assets: [
        { name: "dbchat-1.3.0.zip", browser_download_url: "https://dl/zip" },
        { name: "dbchat-1.3.0-arm64.dmg", browser_download_url: "https://dl/dmg" },
      ],
    });
    expect(await fetchLatestRelease("x/y")).toEqual({ version: "1.3.0", tag: "v1.3.0", url: "https://github.com/x/y/releases/tag/v1.3.0", dmgUrl: "https://dl/dmg", notes: "notes" });
  });

  test("returns undefined when there is no release or no dmg asset", async () => {
    stub(404);
    expect(await fetchLatestRelease("x/y")).toBeUndefined();
    stub(200, { tag_name: "v1.3.0", html_url: "u", assets: [{ name: "a.zip", browser_download_url: "z" }] });
    expect(await fetchLatestRelease("x/y")).toBeUndefined();
  });

  test("throws on other API errors", async () => {
    stub(500);
    await expect(fetchLatestRelease("x/y")).rejects.toThrow("GitHub API 500");
  });
});

describe("Updater.check", () => {
  let dir: string;
  let stateFile: string;
  const logs: string[] = [];
  const realFetch = globalThis.fetch;

  const release = (version: string) => ({
    tag_name: `v${version}`, html_url: "https://rel", body: "",
    assets: [{ name: `dbchat-${version}-arm64.dmg`, browser_download_url: "https://dl/dmg" }],
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dbchat-updater-test-"));
    stateFile = join(dir, "updater.json");
    logs.length = 0;
    electron.dialog.showMessageBox.mockClear();
    electron.shell.openExternal.mockClear();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    unfake();
    rmSync(dir, { recursive: true, force: true });
  });

  const make = () => new Updater({ repo: "x/y", stateFile, log: (l) => logs.push(l), quit: () => {} });

  test("not packaged: interactive check explains, background check is silent", async () => {
    await make().check({ interactive: false });
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled();
    await make().check({ interactive: true });
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  /* Everything below needs installedAppBundle() to return a path — only reachable on darwin. */
  const packaged = process.platform === "darwin";
  test.skipIf(!packaged)("up to date: records lastCheck and does not prompt in the background", async () => {
    fakePackaged();
    globalThis.fetch = mock(async () => Response.json(release("1.2.3"))) as unknown as typeof fetch;
    await make().check({ interactive: false });
    expect(logs.some((l) => l.includes("up to date"))).toBe(true);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).lastCheck).toBeString();
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  test.skipIf(!packaged)("newer release: background check exposes 'available' state without prompting", async () => {
    fakePackaged();
    globalThis.fetch = mock(async () => Response.json(release("1.3.0"))) as unknown as typeof fetch;
    const u = make();
    const seen: string[] = [];
    u.onChange((st) => seen.push(st.status));
    await u.check({ interactive: false });
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(seen).toEqual(["checking", "available"]);
    expect(u.getState().latest).toMatchObject({ version: "1.3.0", url: "https://rel" });
  });

  test.skipIf(!packaged)("install is a no-op until a download is ready", () => {
    fakePackaged();
    let quit = 0;
    const u = new Updater({ repo: "x/y", stateFile, quit: () => { quit++; } });
    u.install();
    expect(quit).toBe(0);
  });

  test.skipIf(!packaged)("'Release Notes' opens the browser and does not download", async () => {
    fakePackaged();
    writeFileSync(stateFile, "{}");
    globalThis.fetch = mock(async () => Response.json(release("1.3.0"))) as unknown as typeof fetch;
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await make().check({ interactive: true });
    expect(electron.shell.openExternal).toHaveBeenCalledWith("https://rel");
  });

  test.skipIf(!packaged)("API failure is logged, and surfaced only when interactive", async () => {
    fakePackaged();
    globalThis.fetch = mock(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await make().check({ interactive: false });
    expect(logs.some((l) => l.includes("check failed: offline"))).toBe(true);
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled();

    await make().check({ interactive: true });
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(electron.dialog.showMessageBox.mock.calls[0]?.[0]).toMatchObject({ type: "error" });
  });

  test.skipIf(!packaged)("concurrent checks are coalesced", async () => {
    fakePackaged();
    let calls = 0;
    globalThis.fetch = mock(async () => { calls++; return Response.json(release("1.2.3")); }) as unknown as typeof fetch;
    const u = make();
    await Promise.all([u.check({ interactive: false }), u.check({ interactive: false })]);
    expect(calls).toBe(1);
  });
});
