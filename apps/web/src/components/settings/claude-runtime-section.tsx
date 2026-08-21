/**
 * "Claude instance" settings: which `claude` binary and which CLAUDE_CONFIG_DIR
 * (login/profile) the server's Agent SDK uses. Stored server-side in
 * `<DBCHAT_HOME>/claude.json`; applied on the next chat turn.
 */
import type { ClaudeRuntimeSettings, ClaudeRuntimeStatus } from "@dbchat/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, CircleHelp, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { claudeSettingsQuery, probeClaudeStatus, saveClaudeSettings } from "@/rpc/ai";

const SOURCE_LABEL: Record<ClaudeRuntimeStatus["binarySource"] | ClaudeRuntimeStatus["configDirSource"], string> = {
  settings: "from these settings",
  env: "from the environment",
  path: "found on PATH",
  bundled: "SDK bundled copy",
  default: "default",
};

function StatusLine({ status, pending }: { status: ClaudeRuntimeStatus | undefined; pending: boolean }) {
  if (pending) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-ink-3">
        <LoaderCircle className="size-3.5 animate-spin" /> Checking login…
      </div>
    );
  }
  if (!status) return null;
  const Icon = status.loggedIn === true ? CheckCircle2 : status.loggedIn === false ? CircleAlert : CircleHelp;
  const tone =
    status.loggedIn === true
      ? "text-emerald-600 dark:text-emerald-400"
      : status.loggedIn === false
        ? "text-red-600 dark:text-red-400"
        : "text-ink-3";
  return (
    <div className="flex flex-col gap-1 rounded-md bg-inset p-2.5 text-xs">
      <div className={`flex items-center gap-1.5 font-medium ${tone}`}>
        <Icon className="size-3.5" />
        {status.loggedIn === true
          ? `Logged in${status.email ? ` as ${status.email}` : ""}${status.apiProvider && status.apiProvider !== "firstParty" ? ` · ${status.apiProvider}` : ""}`
          : status.detail}
      </div>
      <div className="text-ink-3">
        Binary: <span className="font-mono text-ink-2">{status.binaryPath ?? "(bundled)"}</span> · {SOURCE_LABEL[status.binarySource]}
      </div>
      <div className="text-ink-3">
        Config dir: <span className="font-mono text-ink-2">{status.configDir}</span> · {SOURCE_LABEL[status.configDirSource]}
        {!status.configDirExists && " · does not exist yet"}
      </div>
    </div>
  );
}

export function ClaudeRuntimeSection() {
  const qc = useQueryClient();
  const { data: saved } = useQuery(claudeSettingsQuery);
  const [draft, setDraft] = useState<ClaudeRuntimeSettings>({ binaryPath: "", configDir: "" });
  const probe = useMutation({ mutationFn: (s: ClaudeRuntimeSettings) => probeClaudeStatus(s) });
  const save = useMutation({
    mutationFn: saveClaudeSettings,
    onSuccess: (s) => {
      qc.setQueryData(claudeSettingsQuery.queryKey, s);
      probe.mutate(s);
    },
  });

  // Seed the form and probe once when the saved settings arrive.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (saved && !seeded) {
      setDraft(saved);
      setSeeded(true);
      probe.mutate(saved);
    }
  }, [saved, seeded, probe]);

  const dirty = !!saved && (saved.binaryPath !== draft.binaryPath || saved.configDir !== draft.configDir);

  const field = (label: string, hint: string, key: keyof ClaudeRuntimeSettings, placeholder: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-[13px]">{label}</span>
      <Input
        value={draft[key]}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        className="font-mono text-xs"
      />
      <span className="text-[11.5px] text-ink-3">{hint}</span>
    </label>
  );

  return (
    <>
      {field(
        "Claude binary",
        "Leave empty to use `claude` from your PATH (or the bundled copy). Set this to use a specific install.",
        "binaryPath",
        "claude",
      )}
      {field(
        "CLAUDE_CONFIG_DIR",
        "A separate Claude login/profile (e.g. a work or AWS-billed account). Run `CLAUDE_CONFIG_DIR=<dir> claude /login` once to sign it in. HOME is never changed, so keychain logins keep working.",
        "configDir",
        "~/.claude",
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" disabled={probe.isPending} onClick={() => probe.mutate(draft)}>
          Test {dirty ? "unsaved " : ""}settings
        </Button>
        {dirty && <span className="text-[11.5px] text-ink-3">Unsaved changes</span>}
      </div>
      <StatusLine status={probe.data} pending={probe.isPending} />
    </>
  );
}
