import type { ProviderId } from "@dbchat/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Code2,
  Keyboard,
  Monitor,
  Moon,
  Palette,
  Settings2,
  Sun,
  Terminal,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import { ModelCombobox } from "@/components/chat/model-combobox";
import { ClaudeRuntimeSection } from "@/components/settings/claude-runtime-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { SHORTCUTS } from "@/lib/keybindings";
import {
  FONT_SCALES,
  type FontScale,
  type MonoFontPreset,
  type PageSize,
  type RowLimit,
  type ThemePref,
  type UiFontPreset,
  useSettings,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { catalogDefaultModel, findModel, modelsQuery } from "@/rpc/ai";

type SettingsPage = "general" | "appearance" | "providers" | "keybindings";

const NAV_ITEMS: ReadonlyArray<{ id: SettingsPage; label: string; icon: typeof Settings2 }> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "providers", label: "Providers", icon: Bot },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
];

function SettingsCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented<T extends string | number>({ value, options, onChange, label }: {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; title?: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-0.5 rounded-md bg-inset p-0.5 shadow-hairline">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.title ?? String(option.value)}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium transition-colors",
            option.value === value ? "bg-surface text-ink shadow-hairline" : "text-ink-2 hover:text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const PROVIDER_META: Record<ProviderId, { icon: typeof Bot; summary: string }> = {
  anthropic: { icon: Bot, summary: "Claude Code using your existing login" },
  openai: { icon: Code2, summary: "OpenAI Codex coding agent" },
  opencode: { icon: Terminal, summary: "OpenCode with your configured models" },
};

export function SettingsScreen() {
  const navigate = useNavigate();
  const router = useRouter();
  const settings = useSettings();
  const { data: catalog } = useQuery(modelsQuery);
  const serverDefault = catalogDefaultModel(catalog);
  const [page, setPage] = useState<SettingsPage>("general");
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const activeNav = NAV_ITEMS.find((item) => item.id === page)!;
  const selectedProvider = catalog?.find((item) => item.provider === provider);
  /* The provider new chats use: whoever owns the user's default model, else the server default's owner. */
  const defaultProvider = (findModel(catalog, settings.defaultModel) ?? serverDefault)?.provider;
  const isDefaultProvider = defaultProvider === provider;
  /* This provider's pick: the saved one, else the server default when it belongs here, else its first model. */
  const providerModel =
    settings.providerModels[provider] ?? (serverDefault?.provider === provider ? serverDefault.id : selectedProvider?.models[0]?.id) ?? null;
  const chooseProviderModel = (id: string | null) => {
    settings.setProviderModel(provider, id);
    if (isDefaultProvider) settings.setDefaultModel(id, provider);
  };
  const useProviderForNewChats = () => {
    if (providerModel) settings.setDefaultModel(providerModel, provider);
  };

  const back = () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: "/" });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <header data-app-drag="inset" className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={back}><ArrowLeft /></Button>
        <span className="font-semibold tracking-tight">dbchat</span>
        <span className="text-muted-foreground">/</span>
        <span className="text-muted-foreground">Settings</span>
        <span className="text-muted-foreground">/</span>
        <span>{activeNav.label}</span>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col md:flex-row">
        <aside className="shrink-0 border-b border-line p-3 md:w-56 md:border-b-0 md:border-r md:p-5">
          <div className="flex gap-1 overflow-x-auto md:flex-col">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <Button
                  key={item.id}
                  variant={page === item.id ? "secondary" : "ghost"}
                  onClick={() => setPage(item.id)}
                  className="shrink-0 justify-start md:w-full"
                >
                  <Icon />
                  {item.label}
                  {page === item.id ? <ChevronRight className="ml-auto hidden md:block" /> : null}
                </Button>
              );
            })}
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto px-5 pb-16 pt-8 md:px-10">
          <div className="mx-auto flex max-w-2xl flex-col gap-6">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{activeNav.label}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {page === "general" && "Configure data defaults and chat behavior."}
                {page === "appearance" && "Make dbchat feel at home on your system."}
                {page === "providers" && "Choose which coding agent and model powers new chats."}
                {page === "keybindings" && "A quick reference for keyboard shortcuts."}
              </p>
            </div>

            {page === "general" ? (
              <>
                <SettingsCard title="Data" description="Defaults for SQL runs and table tabs.">
                  <SettingRow label="Default row limit" hint="Applied to every statement run from the SQL editor.">
                    <Segmented<RowLimit> label="Default row limit" value={settings.rowLimit} onChange={settings.setRowLimit} options={([100, 500, 1000, 5000] as const).map((n) => ({ value: n, label: n.toLocaleString() }))} />
                  </SettingRow>
                  <Separator />
                  <SettingRow label="Table page size" hint="Rows fetched per page in the table browser.">
                    <Segmented<PageSize> label="Table page size" value={settings.pageSize} onChange={settings.setPageSize} options={([50, 100, 200] as const).map((n) => ({ value: n, label: String(n) }))} />
                  </SettingRow>
                  <Separator />
                  <SettingRow label="Confirm before DML" hint="Ask before running INSERT, UPDATE, DELETE, or DDL.">
                    <Switch checked={settings.confirmDml} onCheckedChange={settings.setConfirmDml} aria-label="Confirm before DML" />
                  </SettingRow>
                </SettingsCard>
                <SettingsCard title="Chat context" description="Control what new messages include automatically.">
                  <SettingRow label="Include current table" hint="Attach the open table as context to a new chat turn.">
                    <Switch checked={settings.autoTableContext} onCheckedChange={settings.setAutoTableContext} aria-label="Include current table as context" />
                  </SettingRow>
                </SettingsCard>
              </>
            ) : null}

            {page === "appearance" ? (
              <SettingsCard title="Theme" description="Follow your OS or pin a theme for dbchat.">
                <SettingRow label="Color theme">
                  <Segmented<ThemePref>
                    label="Theme"
                    value={settings.theme}
                    onChange={settings.setTheme}
                    options={[
                      { value: "system", label: <><Monitor /> System</> },
                      { value: "light", label: <><Sun /> Light</> },
                      { value: "dark", label: <><Moon /> Dark</> },
                    ]}
                  />
                </SettingRow>
              </SettingsCard>
            ) : null}

            {page === "appearance" ? (
              <SettingsCard title="Typography" description="Fonts and size for the interface and the editor.">
                <SettingRow label="Font size" hint="Scales the whole interface, including the editor and tables.">
                  <Segmented<FontScale>
                    label="Font size"
                    value={settings.fontScale}
                    onChange={settings.setFontScale}
                    options={FONT_SCALES.map((f) => ({ value: f.value, label: f.label, title: `${Math.round(f.value * 100)}%` }))}
                  />
                </SettingRow>
                <Separator />
                <SettingRow label="Interface font" hint="Custom uses any font installed on this machine.">
                  <div className="flex items-center gap-2">
                    {settings.uiFont === "custom" && (
                      <Input
                        className="h-7 w-40 text-[12px]"
                        placeholder="e.g. Geist, Helvetica"
                        aria-label="Custom interface font"
                        value={settings.uiFontCustom}
                        onChange={(e) => settings.setUiFont("custom", e.target.value)}
                      />
                    )}
                    <Segmented<UiFontPreset>
                      label="Interface font"
                      value={settings.uiFont}
                      onChange={(v) => settings.setUiFont(v)}
                      options={[
                        { value: "inter", label: "Inter" },
                        { value: "system", label: "System" },
                        { value: "custom", label: "Custom" },
                      ]}
                    />
                  </div>
                </SettingRow>
                <Separator />
                <SettingRow label="Code font" hint="Used by the SQL editor, table cells and code blocks.">
                  <div className="flex items-center gap-2">
                    {settings.monoFont === "custom" && (
                      <Input
                        className="h-7 w-40 font-mono text-[12px]"
                        placeholder="e.g. Fira Code, Menlo"
                        aria-label="Custom code font"
                        value={settings.monoFontCustom}
                        onChange={(e) => settings.setMonoFont("custom", e.target.value)}
                      />
                    )}
                    <Segmented<MonoFontPreset>
                      label="Code font"
                      value={settings.monoFont}
                      onChange={(v) => settings.setMonoFont(v)}
                      options={[
                        { value: "jetbrains", label: "JetBrains Mono" },
                        { value: "system", label: "System" },
                        { value: "custom", label: "Custom" },
                      ]}
                    />
                  </div>
                </SettingRow>
              </SettingsCard>
            ) : null}

            {page === "providers" ? (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  {(catalog ?? []).map((item) => {
                    const Icon = PROVIDER_META[item.provider].icon;
                    const selected = provider === item.provider;
                    return (
                      <button key={item.provider} type="button" onClick={() => setProvider(item.provider)} className="text-left">
                        <Card className={cn("h-full transition-shadow hover:shadow-card", selected && "ring-2 ring-brand")}>
                          <CardHeader>
                            <div className="flex items-center justify-between">
                              <span className="flex size-8 items-center justify-center rounded-md bg-inset"><Icon /></span>
                              {selected ? <Check className="text-brand" /> : null}
                            </div>
                            <CardTitle className="mt-2">{item.label}</CardTitle>
                            <CardDescription>{PROVIDER_META[item.provider].summary}</CardDescription>
                          </CardHeader>
                          <CardContent>
                            <span className={cn("text-xs", item.status === "ready" ? "text-brand-ink" : "text-muted-foreground")}>
                              {item.status === "ready" ? "Ready" : "Setup required"}
                            </span>
                          </CardContent>
                        </Card>
                      </button>
                    );
                  })}
                </div>

                <SettingsCard title={`${selectedProvider?.label ?? "Provider"} settings`} description={selectedProvider?.reason ?? PROVIDER_META[provider].summary}>
                  <SettingRow label="Default model" hint={`Used when ${selectedProvider?.label ?? "this provider"} powers a new chat. Each chat remembers its last model.`}>
                    <ModelCombobox catalog={catalog} value={providerModel} onChange={chooseProviderModel} provider={provider} />
                  </SettingRow>
                  <SettingRow
                    label="Use for new chats"
                    hint={isDefaultProvider ? `New chats start on ${findModel(catalog, providerModel)?.label ?? "this model"}.` : `New chats currently use ${catalog?.find((item) => item.provider === defaultProvider)?.label ?? "the server default"}.`}
                  >
                    <Button variant="outline" size="sm" disabled={isDefaultProvider || selectedProvider?.status !== "ready" || !providerModel} onClick={useProviderForNewChats}>
                      {isDefaultProvider ? <><Check className="text-brand" /> Default</> : `Use ${selectedProvider?.label ?? "provider"}`}
                    </Button>
                  </SettingRow>
                  {provider === "anthropic" ? <><Separator /><ClaudeRuntimeSection /></> : (
                    <p className="rounded-md bg-inset p-3 text-xs text-muted-foreground">
                      {selectedProvider?.status === "ready"
                        ? `${selectedProvider.label} is available through your existing CLI login. Models from this provider are selectable in new and existing chats.`
                        : `${selectedProvider?.reason ?? "Runtime setup is required"}. It will become selectable once the CLI is available.`}
                    </p>
                  )}
                </SettingsCard>
              </>
            ) : null}

            {page === "keybindings" ? (
              <SettingsCard title="Keyboard shortcuts" description="Ctrl replaces ⌘ on Windows and Linux.">
                <div className="rounded-md shadow-hairline">
                  {SHORTCUTS.map((shortcut, index) => (
                    <div key={shortcut.keys} className={cn("flex items-center gap-3 px-3 py-2 text-[13px]", index && "border-t border-line")}>
                      <span className="min-w-0 flex-1">{shortcut.label}</span>
                      <Kbd className="font-mono">{shortcut.keys}</Kbd>
                    </div>
                  ))}
                </div>
              </SettingsCard>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}
