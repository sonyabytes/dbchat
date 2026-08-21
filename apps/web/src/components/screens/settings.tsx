/**
 * Settings screen (`/settings`).
 *
 * Everything here lives in `lib/settings.ts` (zustand + localStorage), including
 * the default model — the server still owns the *catalog* (`ai.models`) and the
 * fallback (`DBCHAT_MODEL`); this only picks which entry new chats start on.
 */
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Bot, Database, Keyboard, Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";

import { TierPill } from "@/components/chat/model-picker";
import { Eyebrow } from "@/components/shared/primitives";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SHORTCUTS } from "@/lib/keybindings";
import {
  type PageSize,
  type RowLimit,
  type ThemePref,
  useSettings,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { catalogDefaultModel, modelLabel, modelsQuery } from "@/rpc/ai";

function Section({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return (
    <section className="rounded-lg bg-surface p-4 shadow-card">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm bg-inset text-ink-2">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-medium">{title}</h2>
          <p className="mt-0.5 text-xs text-ink-3">{description}</p>
          <div className="mt-3 flex flex-col gap-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        {hint && <div className="text-[11.5px] text-ink-3">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; title?: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-0.5 rounded-md bg-inset p-0.5 shadow-hairline">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title ?? String(o.value)}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex h-6 items-center gap-1.5 rounded-sm px-2 text-[11.5px] font-medium transition-colors",
            o.value === value ? "bg-surface text-ink shadow-hairline" : "text-ink-2 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Sentinel for "no preference" — `Select` cannot hold a null value. */
const SERVER_DEFAULT = "__server_default__";

export function SettingsScreen() {
  const navigate = useNavigate();
  const router = useRouter();
  const s = useSettings();
  const { data: catalog } = useQuery(modelsQuery);
  const serverDefault = catalogDefaultModel(catalog);

  const back = () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: "/" });
  };

  return (
    <div className="flex h-full flex-col overflow-auto">
      <header data-app-drag="inset" className="flex h-12 shrink-0 items-center gap-2 px-4">
        <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={back}>
          <ArrowLeft />
        </Button>
        <span className="font-semibold tracking-tight">dbchat</span>
        <span className="text-ink-3">/</span>
        <span className="text-ink-2">Settings</span>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-16 pt-6">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mb-6 text-ink-2">Stored in this browser. Nothing here is sent to the server.</p>

        <div className="flex flex-col gap-3">
          <Section icon={<Sun className="size-3.5" />} title="Appearance" description="Theme follows your OS unless you pin it.">
            <Row label="Theme">
              <Segmented<ThemePref>
                label="Theme"
                value={s.theme}
                onChange={s.setTheme}
                options={[
                  { value: "system", label: <><Monitor className="size-3" /> System</> },
                  { value: "light", label: <><Sun className="size-3" /> Light</> },
                  { value: "dark", label: <><Moon className="size-3" /> Dark</> },
                ]}
              />
            </Row>
          </Section>

          <Section icon={<Database className="size-3.5" />} title="Data" description="Defaults for new SQL runs and table tabs.">
            <Row label="Default row limit" hint="Applied to every statement run from the SQL editor.">
              <Segmented<RowLimit>
                label="Default row limit"
                value={s.rowLimit}
                onChange={s.setRowLimit}
                options={([100, 500, 1000, 5000] as const).map((n) => ({ value: n, label: n.toLocaleString() }))}
              />
            </Row>
            <Row label="Table page size" hint="Rows fetched per page in the table browser.">
              <Segmented<PageSize>
                label="Table page size"
                value={s.pageSize}
                onChange={s.setPageSize}
                options={([50, 100, 200] as const).map((n) => ({ value: n, label: String(n) }))}
              />
            </Row>
            <Row label="Confirm before DML" hint="Ask before running INSERT / UPDATE / DELETE / DDL in the editor.">
              <Switch checked={s.confirmDml} onCheckedChange={s.setConfirmDml} aria-label="Confirm before DML" />
            </Row>
          </Section>

          <Section icon={<Bot className="size-3.5" />} title="AI" description="Which model new chats start on.">
            <Row
              label="Default model"
              hint={
                serverDefault
                  ? `The server default is ${serverDefault.label} (DBCHAT_MODEL). A chat keeps whatever model it last ran on.`
                  : "A chat keeps whatever model it last ran on."
              }
            >
              <Select
                value={s.defaultModel ?? SERVER_DEFAULT}
                onValueChange={(v) => s.setDefaultModel(v === SERVER_DEFAULT ? null : (v as string))}
              >
                <SelectTrigger className="min-w-44" aria-label="Default model">
                  {/* Base UI renders the raw value unless we format it. */}
                  <SelectValue>
                    {(v: string) =>
                      v === SERVER_DEFAULT
                        ? `Server default${serverDefault ? ` (${serverDefault.label})` : ""}`
                        : (modelLabel(catalog, v) ?? v)
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={SERVER_DEFAULT}>
                      Server default{serverDefault ? ` (${serverDefault.label})` : ""}
                    </SelectItem>
                  </SelectGroup>
                  {(catalog ?? []).map((p) => (
                    <SelectGroup key={p.provider}>
                      <SelectLabel>
                        {p.label}
                        {p.status !== "ready" && ` — ${p.reason ?? "unavailable"}`}
                      </SelectLabel>
                      {p.models.map((m) => (
                        <SelectItem key={m.id} value={m.id} disabled={p.status !== "ready"}>
                          {m.label}
                          <TierPill tier={m.tier} />
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label="Include current table as context" hint="Automatically attaches the open table to a new chat turn.">
              <Switch
                checked={s.autoTableContext}
                onCheckedChange={s.setAutoTableContext}
                aria-label="Include current table as context"
              />
            </Row>
          </Section>

          <Section icon={<Keyboard className="size-3.5" />} title="Keyboard shortcuts" description="Ctrl replaces ⌘ on Windows and Linux.">
            <div className="rounded-md shadow-hairline">
              {SHORTCUTS.map((k, i) => (
                <div key={k.keys} className={cn("flex items-center gap-3 px-3 py-1.5 text-[13px]", i && "border-t border-line")}>
                  <span className="min-w-0 flex-1">{k.label}</span>
                  <Kbd className="font-mono">{k.keys}</Kbd>
                </div>
              ))}
            </div>
          </Section>
        </div>

        <Eyebrow className="mt-6 text-center">dbchat · settings are per browser</Eyebrow>
      </main>
    </div>
  );
}
