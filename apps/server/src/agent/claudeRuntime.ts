/**
 * Which Claude Code instance the Agent SDK talks to, and with what environment.
 *
 * Mirrors how T3 Code does it: the user can point dbchat at any `claude`
 * binary and any `CLAUDE_CONFIG_DIR` (a separate login / account), and the
 * SDK is started with the *login-shell* environment so `ANTHROPIC_BASE_URL`,
 * `CLAUDE_CODE_USE_BEDROCK`, `AWS_*` etc. from `.zshrc` reach it even when the
 * desktop app was launched from Finder.
 *
 * Resolution order (first wins):
 *   binary:     settings.binaryPath → DBCHAT_CLAUDE_CLI → `claude` on PATH → SDK bundled
 *   config dir: settings.configDir  → DBCHAT_CLAUDE_CONFIG_DIR → CLAUDE_CONFIG_DIR → ~/.claude
 *
 * Settings live in `<DBCHAT_HOME>/claude.json` and are read on every turn so a
 * change in the Settings screen applies without restarting the server.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import type { ClaudeRuntimeSettings, ClaudeRuntimeStatus } from "@dbchat/contracts";

export const CLAUDE_SETTINGS_FILE = "claude.json";

/** `~/.claude/settings.json` + project + local — same sources the CLI reads, so `env` blocks apply. */
export const CLAUDE_SETTING_SOURCES = ["user", "project", "local"] as const;

const EMPTY: ClaudeRuntimeSettings = { binaryPath: "", configDir: "" };

export const dbchatHome = (env: NodeJS.ProcessEnv = process.env): string => env.DBCHAT_HOME ?? join(homedir(), ".dbchat");

export const expandHome = (p: string): string => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export const loadClaudeSettings = (home: string = dbchatHome()): ClaudeRuntimeSettings => {
  try {
    const raw = JSON.parse(readFileSync(join(home, CLAUDE_SETTINGS_FILE), "utf8")) as Partial<ClaudeRuntimeSettings>;
    return {
      binaryPath: typeof raw.binaryPath === "string" ? raw.binaryPath.trim() : "",
      configDir: typeof raw.configDir === "string" ? raw.configDir.trim() : "",
    };
  } catch {
    return EMPTY;
  }
};

export const saveClaudeSettings = (settings: ClaudeRuntimeSettings, home: string = dbchatHome()): ClaudeRuntimeSettings => {
  const clean: ClaudeRuntimeSettings = { binaryPath: settings.binaryPath.trim(), configDir: settings.configDir.trim() };
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, CLAUDE_SETTINGS_FILE), JSON.stringify(clean, null, 2) + "\n");
  return clean;
};

/* ---------------- login-shell environment ---------------- */

let shellEnvCache: NodeJS.ProcessEnv | undefined;

/**
 * Environment of the user's interactive login shell (`$SHELL -ilc env`), cached
 * per process. Empty on Windows or when the shell cannot be run.
 */
export const loginShellEnv = (): NodeJS.ProcessEnv => {
  if (shellEnvCache) return shellEnvCache;
  shellEnvCache = {};
  if (process.platform === "win32") return shellEnvCache;
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const out = execFileSync(shell, ["-ilc", "command env -0"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TERM: "dumb" },
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const entry of out.split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) shellEnvCache[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  } catch {
    // Non-fatal: fall back to process.env only.
  }
  return shellEnvCache;
};

/**
 * process.env wins over the shell for everything except PATH, where the shell's
 * (usually longer) PATH is merged in front so `claude`, `aws` etc. are found.
 */
export const mergedBaseEnv = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const shell = loginShellEnv();
  const merged: NodeJS.ProcessEnv = { ...shell, ...base };
  const paths = [...(shell.PATH ?? "").split(delimiter), ...(base.PATH ?? "").split(delimiter)].filter(Boolean);
  merged.PATH = [...new Set(paths)].join(delimiter);
  return merged;
};

/* ---------------- binary + config dir ---------------- */

const isExecutableFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export const findOnPath = (cmd: string, env: NodeJS.ProcessEnv): string | undefined => {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
};

export interface ResolvedClaudeRuntime {
  /** `undefined` = let the SDK use its bundled binary. */
  readonly binaryPath: string | undefined;
  readonly binarySource: "settings" | "env" | "path" | "bundled";
  readonly configDir: string;
  readonly configDirSource: "settings" | "env" | "default";
  readonly env: NodeJS.ProcessEnv;
}

export const resolveClaudeRuntime = (args?: {
  settings?: ClaudeRuntimeSettings;
  baseEnv?: NodeJS.ProcessEnv;
  home?: string;
}): ResolvedClaudeRuntime => {
  const settings = args?.settings ?? loadClaudeSettings(args?.home);
  const env = mergedBaseEnv(args?.baseEnv);

  const resolveBinary = (): Pick<ResolvedClaudeRuntime, "binaryPath" | "binarySource"> => {
    const fromSettings = settings.binaryPath ? expandHome(settings.binaryPath) : "";
    if (fromSettings) {
      const p = isAbsolute(fromSettings) || fromSettings.includes("/") ? resolve(fromSettings) : findOnPath(fromSettings, env);
      if (p && isExecutableFile(p)) return { binaryPath: p, binarySource: "settings" };
    }
    const fromEnv = env.DBCHAT_CLAUDE_CLI?.trim();
    if (fromEnv && isExecutableFile(fromEnv)) return { binaryPath: fromEnv, binarySource: "env" };
    const onPath = findOnPath("claude", env);
    if (onPath) return { binaryPath: onPath, binarySource: "path" };
    return { binaryPath: undefined, binarySource: "bundled" };
  };

  const resolveConfigDir = (): Pick<ResolvedClaudeRuntime, "configDir" | "configDirSource"> => {
    if (settings.configDir) return { configDir: resolve(expandHome(settings.configDir)), configDirSource: "settings" };
    const fromEnv = (env.DBCHAT_CLAUDE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR)?.trim();
    if (fromEnv) return { configDir: resolve(expandHome(fromEnv)), configDirSource: "env" };
    return { configDir: join(homedir(), ".claude"), configDirSource: "default" };
  };

  const bin = resolveBinary();
  const cfg = resolveConfigDir();
  const finalEnv: NodeJS.ProcessEnv = { ...env };
  // Never override HOME: that would relocate the macOS keychain and break OAuth lookup.
  if (cfg.configDirSource !== "default") finalEnv.CLAUDE_CONFIG_DIR = cfg.configDir;
  // The SDK must not pick up a stale pointer meant for another binary.
  delete finalEnv.DBCHAT_CLAUDE_CLI;
  delete finalEnv.DBCHAT_CLAUDE_CONFIG_DIR;
  return { ...bin, ...cfg, env: finalEnv };
};

/** SDK `Options` slice shared by chat and suggest: binary, env, settings sources. */
export const claudeSdkOptions = (clientApp: string) => {
  const rt = resolveClaudeRuntime();
  return {
    settingSources: [...CLAUDE_SETTING_SOURCES],
    env: { ...rt.env, CLAUDE_AGENT_SDK_CLIENT_APP: clientApp },
    ...(rt.binaryPath ? { pathToClaudeCodeExecutable: rt.binaryPath } : {}),
  };
};

/* ---------------- auth probe ---------------- */

const run = (file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) =>
  new Promise<{ stdout: string; stderr: string; error: Error | null }>((done) => {
    execFile(file, args, { encoding: "utf8", timeout: 10_000, env, cwd }, (error, stdout, stderr) =>
      done({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), error }),
    );
  });

/** Runs `claude auth status --json` with the resolved binary + env. Never rejects. */
export const probeClaudeStatus = async (settings?: ClaudeRuntimeSettings): Promise<ClaudeRuntimeStatus> => {
  const rt = resolveClaudeRuntime(settings ? { settings } : undefined);
  const base = {
    binaryPath: rt.binaryPath ?? null,
    binarySource: rt.binarySource,
    configDir: rt.configDir,
    configDirSource: rt.configDirSource,
    configDirExists: existsSync(rt.configDir),
  };
  if (!rt.binaryPath) {
    return { ...base, loggedIn: null, detail: "No `claude` binary found; the SDK's bundled copy will be used." };
  }
  const res = await run(rt.binaryPath, ["auth", "status", "--json"], rt.env, dirname(rt.binaryPath));
  const out = res.stdout.trim();
  try {
    const j = JSON.parse(out.slice(out.indexOf("{"))) as {
      loggedIn?: boolean;
      authMethod?: string;
      apiProvider?: string;
      email?: string;
      organization?: string;
    };
    return {
      ...base,
      loggedIn: j.loggedIn === true,
      ...(j.authMethod ? { authMethod: j.authMethod } : {}),
      ...(j.apiProvider ? { apiProvider: j.apiProvider } : {}),
      ...(j.email ? { email: j.email } : {}),
      detail: j.loggedIn ? "Logged in" : "Not logged in — run `claude /login` with this binary and config dir.",
    };
  } catch {
    const err = res.stderr.trim() || out || res.error?.message || "unknown error";
    return { ...base, loggedIn: null, detail: `Could not read auth status: ${err.slice(0, 300)}` };
  }
};
