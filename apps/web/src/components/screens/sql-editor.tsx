import { PostgreSQL, sql as sqlLang } from "@codemirror/lang-sql";
import { EditorView, keymap } from "@codemirror/view";
import type { ConnectionId, SqlResult, SqlSuggestion } from "@dbchat/contracts";
import { useDebouncedCallback } from "@tanstack/react-pacer";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import CodeMirror, { Prec, type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { Check, ChevronDown, Play, Save, Sparkles, Square, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DataGrid } from "@/components/shared/data-grid";
import { gridColumns, gridRows, ToolChip } from "@/components/shared/primitives";
import { HistoryPopover } from "@/components/sql/history-popover";
import { describeRpcError, positionToLine, type RpcErrorInfo } from "@/components/sql/rpc-error";
import { SaveQueryDialog } from "@/components/sql/save-dialog";
import { splitStatements, statementAt } from "@/components/sql/split";
import { SuggestionCard } from "@/components/sql/suggestion-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useChat } from "@/lib/chat-store";
import { useConnectionId } from "@/lib/nav";
import { type RowLimit, useSettings } from "@/lib/settings";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { schemaListQuery } from "@/rpc/queries";
import {
  cancelSql,
  explainSql,
  historyKey,
  runSql,
  savedKey,
  savedQueriesQuery,
  saveQuery,
  suggestSql,
  tableDetailQuery,
} from "@/rpc/sql";

const theme = EditorView.theme({
  "&": { fontSize: "13px", backgroundColor: "transparent", height: "100%" },
  ".cm-content": { fontFamily: "var(--font-mono)", padding: "12px 0" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--ink-3)", fontFamily: "var(--font-mono)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--ink-3) 8%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--brand-tint) !important" },
  ".cm-cursor": { borderLeftColor: "var(--brand)" },
});

/** Rough client-side write check for the "confirm before DML" setting — the server is still the real gate. */
const DML_RE = /^(insert|update|delete|drop|alter|truncate|create|replace|merge|grant|revoke|vacuum|call)\b/i;
export function isWriteStatement(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  return DML_RE.test(stripped);
}

/** Tables mentioned in the buffer — we pull their columns for autocomplete. */
function referencedTables(sql: string): Array<{ schema: string; table: string }> {
  const out = new Map<string, { schema: string; table: string }>();
  const re = /\b(?:from|join|update|into)\s+([A-Za-z_][\w$]*)(?:\.([A-Za-z_][\w$]*))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) && out.size < 8) {
    const [, a, b] = m;
    const schema = b ? a! : "public";
    const table = b ?? a!;
    out.set(`${schema}.${table}`, { schema, table });
  }
  return [...out.values()];
}

export function SqlEditor({ queryId: queryIdProp }: { queryId?: string } = {}) {
  const connectionId = useConnectionId();
  const params = useParams({ strict: false }) as { queryId?: string };
  const queryId = queryIdProp ?? params.queryId ?? "new";
  const search = useSearch({ strict: false }) as { sql?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const dark = useApp((s) => s.dark);
  const connection = useApp((s) => s.connection);
  const currentThread = useChat((s) => s.currentThread[connectionId]);

  const [code, setCode] = useState(search.sql ?? "");
  const [runId, setRunId] = useState<string | null>(null);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<RpcErrorInfo | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [tab, setTab] = useState<"results" | "messages" | "plan">("results");
  const [readOnly, setReadOnly] = useState(true);
  const settingsLimit = useSettings((s) => s.rowLimit);
  const confirmDml = useSettings((s) => s.confirmDml);
  const [limit, setLimit] = useState(settingsLimit);
  /** null = no dialog; otherwise the statement waiting on confirmation. */
  const [pendingWrite, setPendingWrite] = useState<string | null>(null);
  const [confirmReadOnlyOff, setConfirmReadOnlyOff] = useState(false);
  const isProd = connection?.env === "prod";
  const [suggestion, setSuggestion] = useState<(SqlSuggestion & { cursor: number }) | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /* Follow the Settings default until the user overrides it in the toolbar. */
  useEffect(() => setLimit(settingsLimit), [settingsLimit]);

  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const suggestGen = useRef(0);
  const loadedFor = useRef<string | null>(search.sql ? "prefill" : null);

  /* ---------- saved query loading ---------- */
  const { data: savedList } = useQuery(savedQueriesQuery(connectionId));
  const savedQuery = savedList?.find((s) => s.id === queryId);
  useEffect(() => {
    if (queryId !== "new" && savedQuery && loadedFor.current !== savedQuery.id) {
      loadedFor.current = savedQuery.id;
      setCode(savedQuery.sql);
    }
  }, [queryId, savedQuery]);

  /* ---------- schema-aware autocomplete ---------- */
  const { data: schemas } = useQuery({
    ...schemaListQuery(connectionId as ConnectionId),
    enabled: Boolean(connectionId),
  });
  const refs = useMemo(() => referencedTables(code), [code]);
  const details = useQueries({
    queries: refs.map((r) => ({ ...tableDetailQuery(connectionId, r.schema, r.table), retry: false })),
  });
  const detailData = details.map((d) => d.data).filter(Boolean);
  const schemaMap = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const s of schemas ?? [])
      for (const t of s.tables) {
        m[`${s.name}.${t.name}`] = [];
        if (s.name === "public") m[t.name] ??= [];
      }
    for (const d of detailData) {
      if (!d) continue;
      const cols = d.columns.map((c) => c.name);
      m[`${d.table.schema}.${d.table.name}`] = cols;
      if (d.table.schema === "public") m[d.table.name] = cols;
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemas, JSON.stringify(detailData.map((d) => d?.table.name ?? ""))]);

  /* ---------- run / cancel / explain ---------- */
  const currentStatement = useCallback(() => {
    const view = cmRef.current?.view;
    const doc = view?.state.doc.toString() ?? code;
    const sel = view?.state.selection.main;
    if (sel && !sel.empty) return { from: sel.from, text: doc.slice(sel.from, sel.to).trim() };
    const stmt = statementAt(doc, sel?.head ?? doc.length);
    return stmt ? { from: stmt.from, text: stmt.text } : { from: 0, text: doc.trim() };
  }, [code]);

  const execute = useCallback(async (from: number, text: string) => {
    const id = `r_${Date.now().toString(36)}`;
    setRunId(id);
    setError(null);
    setTab("results");
    try {
      const res = await runSql({ connectionId, sql: text, limit, readOnly, runId: id });
      setResult(res);
    } catch (e) {
      const info = describeRpcError(e);
      setError(info);
      setResult(null);
      setTab("messages");
      if (info.position !== undefined) {
        const view = cmRef.current?.view;
        if (view) {
          const pos = Math.min(view.state.doc.length, from + Math.max(0, info.position - 1));
          view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
          view.focus();
        }
      }
    } finally {
      setRunId(null);
      void qc.invalidateQueries({ queryKey: historyKey(connectionId) });
    }
  }, [connectionId, limit, qc, readOnly]);

  /** Toolbar / ⌘↵ entry point — applies the "confirm before DML" setting. */
  const run = useCallback(async () => {
    const { from, text } = currentStatement();
    if (!text) return;
    if (confirmDml && !readOnly && isWriteStatement(text)) {
      setPendingWrite(text);
      return;
    }
    await execute(from, text);
  }, [currentStatement, confirmDml, readOnly, execute]);

  /** Read-only off is a real safety change; on prod it needs a second click. */
  const requestReadOnly = useCallback(
    (next: boolean) => {
      if (!next && isProd) {
        setConfirmReadOnlyOff(true);
        return;
      }
      setReadOnly(next);
    },
    [isProd],
  );

  const explain = useCallback(async () => {
    const { text } = currentStatement();
    if (!text) return;
    setError(null);
    try {
      const res = await explainSql({ connectionId, sql: text, readOnly });
      setPlan(res.plan);
      setTab("plan");
    } catch (e) {
      setError(describeRpcError(e));
      setTab("messages");
    }
  }, [connectionId, currentStatement, readOnly]);

  const cancel = useCallback(() => {
    if (runId) void cancelSql(runId).catch(() => {});
  }, [runId]);

  const optimise = () => {
    const { text } = currentStatement();
    void navigate({
      to: "/c/$connectionId/chat/$threadId",
      params: { connectionId, threadId: currentThread ?? "home" },
      search: { sql: text || code },
    });
  };

  const doSave = async (name: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      const q = await saveQuery({ connectionId, name, sql: code, ...(queryId === "new" ? {} : { id: queryId }) });
      void qc.invalidateQueries({ queryKey: savedKey(connectionId) });
      setSaveOpen(false);
      loadedFor.current = q.id;
      void navigate({ to: "/c/$connectionId/sql/$queryId", params: { connectionId, queryId: q.id }, search: {} });
    } catch (e) {
      setSaveError(describeRpcError(e).message);
    } finally {
      setSaving(false);
    }
  };

  /* ---------- inline suggestion ---------- */
  const requestSuggestion = useDebouncedCallback(
    (buffer: string, cursor: number) => {
      const gen = ++suggestGen.current;
      void suggestSql({ connectionId, sql: buffer, cursor })
        .then((r) => {
          if (gen === suggestGen.current && r.suggestion) setSuggestion({ ...r.suggestion, cursor });
        })
        .catch(() => {});
    },
    { wait: 900 },
  );

  const acceptSuggestion = useCallback(() => {
    const s = suggestion;
    const view = cmRef.current?.view;
    if (!s || !view) return false;
    const pos = Math.min(s.cursor, view.state.doc.length);
    const line = view.state.doc.lineAt(pos);
    const insert = pos === line.to && /^\s/.test(s.text) ? `\n${s.text.replace(/^\n/, "")}` : s.text;
    view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
    setSuggestion(null);
    return true;
  }, [suggestion]);

  /* keep the keymap stable — the handlers read from refs */
  const handlers = useRef({ run, acceptSuggestion, dismiss: () => setSuggestion(null), hasSuggestion: false });
  handlers.current = { run, acceptSuggestion, dismiss: () => setSuggestion(null), hasSuggestion: Boolean(suggestion) };

  const extensions = useMemo(
    () => [
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              void handlers.current.run();
              return true;
            },
          },
          { key: "Tab", run: () => (handlers.current.hasSuggestion ? handlers.current.acceptSuggestion() : false) },
          {
            key: "Escape",
            run: () => {
              if (!handlers.current.hasSuggestion) return false;
              handlers.current.dismiss();
              return true;
            },
          },
        ]),
      ),
      sqlLang({ dialect: PostgreSQL, schema: schemaMap, upperCaseKeywords: false }),
      theme,
    ],
    [schemaMap],
  );

  /* ⌘↵ also works when focus is outside the editor (results pane, toolbar) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handlers.current.run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const statements = useMemo(() => splitStatements(code).length, [code]);
  const running = runId !== null;
  const cols = result ? gridColumns(result.columns) : [];
  const rows = result ? gridRows(result.columns, result.rows) : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-3">
        {running ? (
          <Button size="xs" variant="secondary" onClick={cancel}>
            <Square /> Cancel
          </Button>
        ) : (
          <Button size="xs" onClick={() => void run()} disabled={!code.trim()}>
            <Play /> Run <Kbd className="ml-1 bg-primary-foreground/15 text-primary-foreground">⌘↵</Kbd>
          </Button>
        )}
        <Button variant="ghost" size="xs" onClick={() => setSaveOpen(true)} disabled={!code.trim()}>
          <Save /> Save
        </Button>
        <HistoryPopover
          connectionId={connectionId}
          onPick={(s) => {
            setCode(s);
            loadedFor.current = "history";
          }}
        />
        <div className="mx-1 h-4 w-px bg-line-strong" />
        <Button variant="ghost" size="xs" className="text-brand-ink" onClick={() => void explain()}>
          <Wand2 className="text-brand" /> Explain
        </Button>
        <Button variant="ghost" size="xs" className="text-brand-ink" onClick={optimise}>
          <Sparkles className="text-brand" /> Optimise
        </Button>

        <div className="ml-auto flex min-w-0 items-center gap-2 whitespace-nowrap text-xs text-ink-3">
          <span className="max-w-[140px] truncate font-mono">{connection?.name ?? connectionId}</span>
          <span>·</span>
          <DropdownMenu>
            <DropdownMenuTrigger render={<button type="button" className="flex items-center gap-1 hover:text-ink" />}>
              <span className="max-w-[120px] truncate">{savedQuery?.name ?? "saved"}</span>
              <ChevronDown className="size-3 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              {(savedList?.length ?? 0) === 0 && <DropdownMenuItem disabled>No saved queries</DropdownMenuItem>}
              {savedList?.map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  onClick={() =>
                    void navigate({
                      to: "/c/$connectionId/sql/$queryId",
                      params: { connectionId, queryId: s.id },
                      search: {},
                    })
                  }
                >
                  {s.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <span>·</span>
          <DropdownMenu>
            <DropdownMenuTrigger render={<button type="button" className="flex items-center gap-1 hover:text-ink" />}>
              limit {limit} <ChevronDown className="size-3 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {([100, 500, 1000, 5000] as const satisfies ReadonlyArray<RowLimit>).map((n) => (
                <DropdownMenuItem key={n} onClick={() => setLimit(n)}>
                  limit {n}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <span>·</span>
          <button
            type="button"
            onClick={() => requestReadOnly(!readOnly)}
            className={cn("shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[11px]", readOnly ? "bg-success-tint text-success" : "bg-danger-tint text-danger")}
            title="Toggle read-only execution"
          >
            {readOnly ? "read-only" : "writes on"}
          </button>
        </div>
      </div>

      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={48} minSize={20} className="relative bg-surface">
          <CodeMirror
            ref={cmRef}
            value={code}
            onChange={(value, vu) => {
              setCode(value);
              setSuggestion(null);
              suggestGen.current += 1;
              const head = vu.state.selection.main.head;
              const line = vu.state.doc.lineAt(head);
              if (value.trim() && head === line.to) requestSuggestion(value, head);
            }}
            height="100%"
            theme={dark ? "dark" : "light"}
            placeholder="select … — ⌘↵ runs the statement under the cursor"
            extensions={extensions}
            basicSetup={{ foldGutter: false, highlightActiveLine: true, autocompletion: true }}
            className="h-full [&_.cm-editor]:h-full"
          />
          {suggestion && (
            <SuggestionCard
              text={suggestion.text}
              reason={suggestion.reason}
              onAccept={() => acceptSuggestion()}
              onDismiss={() => setSuggestion(null)}
            />
          )}
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={52} minSize={20} className="flex min-h-0 flex-col bg-surface">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
            <button
              type="button"
              onClick={() => setTab("results")}
              className={cn("font-medium", tab === "results" ? "text-ink" : "text-ink-2 hover:text-ink")}
            >
              Results
            </button>
            {running && <ToolChip icon="sql" label="running" status="running" />}
            {!running && result && (
              <ToolChip
                icon="sql"
                label={`${result.rowCount.toLocaleString()} ${result.rowCount === 1 ? "row" : "rows"}`}
                detail={`${Math.round(result.durationMs)} ms${result.truncated ? " · truncated" : ""}`}
              />
            )}
            {!running && error && <ToolChip icon="sql" label={error.tag ?? "error"} status="error" />}
            <span className="text-ink-3">·</span>
            <button
              type="button"
              onClick={() => setTab("messages")}
              className={cn(tab === "messages" ? "text-ink" : "text-ink-2 hover:text-ink")}
            >
              Messages
            </button>
            <button
              type="button"
              onClick={() => (plan ? setTab("plan") : void explain())}
              className={cn(tab === "plan" ? "text-ink" : "text-ink-2 hover:text-ink")}
            >
              Plan
            </button>
            <div className="ml-auto flex items-center gap-1 text-ink-3">
              <span className="font-mono text-[10.5px]">{statements} stmt</span>
              <span>·</span>
              <button
                type="button"
                className="hover:text-ink"
                onClick={() => void navigator.clipboard?.writeText(toTsv(cols.map((c) => c.name), rows))}
              >
                Copy
              </button>
              <span>·</span>
              <button
                type="button"
                className="hover:text-ink"
                onClick={() => downloadCsv(cols.map((c) => c.name), rows)}
              >
                CSV
              </button>
            </div>
          </div>

          {tab === "results" && (
            result ? (
              <DataGrid dense columns={cols} rows={rows} className="min-h-0 flex-1" />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-ink-3">
                {running ? "Running…" : "Run a statement to see results."}
              </div>
            )
          )}

          {tab === "messages" && (
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {error ? (
                <div className="rounded-md bg-danger-tint p-3 text-xs text-danger shadow-hairline">
                  <div className="font-medium">{error.tag === "WriteBlocked" ? "Write blocked" : (error.tag ?? "Error")}</div>
                  <p className="mt-1 whitespace-pre-wrap font-mono text-[11.5px]">{error.message}</p>
                  {error.position !== undefined && (
                    <p className="mt-1 font-mono text-[11px] opacity-80">
                      at line {positionToLine(currentStatement().text, error.position).line}, column{" "}
                      {positionToLine(currentStatement().text, error.position).column}
                    </p>
                  )}
                  {error.tag === "WriteBlocked" && (
                    <p className="mt-2 flex items-center gap-2 text-[11px]">
                      Read-only mode is on.
                      <Button size="xs" variant="outline" onClick={() => requestReadOnly(false)}>
                        Turn read-only off
                      </Button>
                    </p>
                  )}
                </div>
              ) : result ? (
                <p className="font-mono text-[11.5px] text-ink-2">
                  <Check className="mr-1 inline size-3.5 text-success" />
                  {result.command ?? "OK"} · {result.rowCount.toLocaleString()} {result.rowCount === 1 ? "row" : "rows"} · {Math.round(result.durationMs)} ms
                </p>
              ) : (
                <p className="text-xs text-ink-3">No messages.</p>
              )}
            </div>
          )}

          {tab === "plan" && (
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {plan ? (
                <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-ink">{plan}</pre>
              ) : (
                <p className="text-xs text-ink-3">Run “Explain” to see the plan.</p>
              )}
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>

      <SaveQueryDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        defaultName={savedQuery?.name ?? "untitled"}
        saving={saving}
        error={saveError}
        onSave={(name) => void doSave(name)}
      />

      <Dialog open={pendingWrite !== null} onOpenChange={(o) => { if (!o) setPendingWrite(null); }}>
        <DialogContent className="sm:max-w-md" data-testid="dml-confirm">
          <DialogHeader>
            <DialogTitle>Run a write statement?</DialogTitle>
            <DialogDescription>
              This modifies data on <span className="font-mono text-ink">{connection?.name ?? connectionId}</span>
              {isProd ? <span className="font-medium text-danger"> — a production database.</span> : "."} Turn the
              confirmation off in Settings → Data.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-40 overflow-auto rounded-sm bg-inset px-2.5 py-2 font-mono text-[11.5px]">{pendingWrite}</pre>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setPendingWrite(null)}>Cancel</Button>
            <Button
              size="sm"
              onClick={() => {
                const text = pendingWrite;
                setPendingWrite(null);
                if (text) void execute(currentStatement().from, text);
              }}
            >
              Run it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmReadOnlyOff} onOpenChange={setConfirmReadOnlyOff}>
        <DialogContent className="sm:max-w-md ring-danger/40" data-testid="readonly-off-confirm">
          <DialogHeader>
            <DialogTitle className="text-danger">Allow writes on production?</DialogTitle>
            <DialogDescription>
              <span className="font-mono text-ink">{connection?.name ?? connectionId}</span> is a production database.
              Turning read-only off lets this editor run INSERT / UPDATE / DELETE / DDL directly.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setConfirmReadOnlyOff(false)}>Keep read-only</Button>
            <Button size="sm" variant="destructive" onClick={() => { setReadOnly(false); setConfirmReadOnlyOff(false); }}>
              Turn read-only off
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function toTsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  return [headers.join("\t"), ...rows.map((r) => headers.map((h) => String(r[h] ?? "")).join("\t"))].join("\n");
}

function downloadCsv(headers: string[], rows: Array<Record<string, unknown>>) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.map(esc).join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "result.csv";
  a.click();
  URL.revokeObjectURL(url);
}
