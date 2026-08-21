/**
 * Create / edit a connection. TanStack Form drives validation, which is
 * dialect-aware: SQLite needs only a file path, Postgres/MySQL accept either a
 * connection URL or discrete fields.
 */
import { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, TestTube2 } from "lucide-react";
import type { Connection, ConnectionEnv, ConnectionInput, Dialect, SslMode } from "@dbchat/contracts";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DialectIcon } from "@/components/shared/primitives";
import { connectionApi, connectionKeys } from "@/rpc/connections";
import { rpcErrorMessage } from "@/rpc/queries";
import { cn } from "@/lib/utils";

interface FormValues {
  name: string;
  dialect: Dialect;
  mode: "fields" | "url";
  url: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  env: ConnectionEnv;
  ssl: SslMode;
  readOnlyForAi: boolean;
}

const defaultPort = (d: Dialect) => (d === "mysql" ? "3306" : d === "postgres" ? "5432" : "");

const emptyValues = (): FormValues => ({
  name: "", dialect: "postgres", mode: "fields", url: "", host: "localhost", port: "5432",
  database: "", user: "", password: "", env: "local", ssl: "prefer", readOnlyForAi: true,
});

const fromConnection = (c: Connection): FormValues => ({
  name: c.name, dialect: c.dialect, mode: "fields", url: "",
  host: c.host, port: String(c.port || defaultPort(c.dialect)), database: c.database, user: c.user,
  password: "", env: c.env, ssl: c.ssl, readOnlyForAi: c.readOnlyForAi,
});

function toConnectionInput(v: FormValues): ConnectionInput {
  const base = { name: v.name.trim(), dialect: v.dialect, env: v.env, ssl: v.ssl, readOnlyForAi: v.readOnlyForAi };
  if (v.dialect === "sqlite") return { ...base, database: v.database.trim() };
  if (v.mode === "url") return { ...base, url: v.url.trim() };
  return {
    ...base,
    host: v.host.trim(),
    port: Number(v.port),
    database: v.database.trim(),
    user: v.user.trim(),
    ...(v.password ? { password: v.password } : {}),
  };
}

/** Dialect-aware validation, run at form level so it can see `dialect` + `mode`. */
function validate({ value }: { value: FormValues }) {
  const fields: Record<string, string> = {};
  if (!value.name.trim()) fields.name = "Required";
  if (value.dialect === "sqlite") {
    if (!value.database.trim()) fields.database = "File path required";
    else if (!value.database.trim().startsWith("/") && !value.database.trim().startsWith("."))
      fields.database = "Use an absolute or ./relative path";
  } else if (value.mode === "url") {
    const u = value.url.trim();
    const scheme = value.dialect === "mysql" ? /^mysql:\/\// : /^postgres(ql)?:\/\//;
    if (!u) fields.url = "Required";
    else if (!scheme.test(u)) fields.url = value.dialect === "mysql" ? "Must start with mysql://" : "Must start with postgres://";
  } else {
    if (!value.host.trim()) fields.host = "Required";
    const port = Number(value.port);
    if (!value.port.trim() || !Number.isInteger(port) || port < 1 || port > 65535) fields.port = "1–65535";
    if (!value.database.trim()) fields.database = "Required";
    if (!value.user.trim()) fields.user = "Required";
  }
  return Object.keys(fields).length > 0 ? { fields } : undefined;
}

function FieldError({ errors, touched }: { errors: unknown[]; touched: boolean }) {
  if (!touched || errors.length === 0) return null;
  return <span className="text-[11px] text-danger">{String(errors[0])}</span>;
}

export function ConnectionFormDialog({
  open, onOpenChange, connection, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection?: Connection | null;
  onSaved?: (c: Connection, isNew: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const editing = Boolean(connection);
  const [showPw, setShowPw] = useState(false);
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "error"; message?: string }>({ state: "idle" });
  const [saveError, setSaveError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: connection ? fromConnection(connection) : emptyValues(),
    validators: { onChange: validate, onSubmit: validate },
    onSubmit: async ({ value }) => {
      setSaveError(null);
      try {
        const input = toConnectionInput(value);
        const saved = connection
          ? await connectionApi.update(connection.id, input)
          : await connectionApi.create(input);
        await queryClient.invalidateQueries({ queryKey: connectionKeys.list });
        onOpenChange(false);
        onSaved?.(saved, !connection);
      } catch (error) {
        setSaveError(rpcErrorMessage(error));
      }
    },
  });

  // Re-seed when the dialog is reopened for a different row.
  useEffect(() => {
    if (!open) return;
    form.reset(connection ? fromConnection(connection) : emptyValues());
    setTest({ state: "idle" });
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connection?.id]);

  const runTest = async () => {
    setTest({ state: "testing" });
    try {
      const result = await connectionApi.test(toConnectionInput(form.state.values));
      // Server version strings are long ("PostgreSQL 18.3 (Homebrew) on aarch64-… compiled by …").
      const version = result.serverVersion?.split(",")[0]?.split(" on ")[0]?.trim();
      setTest(
        result.ok
          ? { state: "ok", message: `Connected in ${Math.round(result.latencyMs)}ms${version ? ` · ${version}` : ""}` }
          : { state: "error", message: result.error ?? "Connection failed" },
      );
    } catch (error) {
      setTest({ state: "error", message: rpcErrorMessage(error) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${connection?.name}` : "New connection"}</DialogTitle>
          <DialogDescription>Credentials stay on this machine. Nothing is sent to the model.</DialogDescription>
        </DialogHeader>

        <form
          className="grid min-w-0 gap-4"
          onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); void form.handleSubmit(); }}
        >
          <form.Field name="dialect">
            {(field) => (
              <div className="grid grid-cols-3 gap-2">
                {(["postgres", "mysql", "sqlite"] as Dialect[]).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      field.handleChange(d);
                      form.setFieldValue("port", defaultPort(d));
                      if (d === "sqlite") form.setFieldValue("mode", "fields");
                    }}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-3 py-2 text-sm shadow-hairline transition-colors",
                      field.state.value === d ? "bg-brand-tint text-brand-ink ring-1 ring-brand/40" : "bg-surface hover:bg-hover",
                    )}
                  >
                    <DialectIcon dialect={d} />
                    <span className="capitalize">{d === "sqlite" ? "SQLite" : d === "mysql" ? "MySQL" : "Postgres"}</span>
                  </button>
                ))}
              </div>
            )}
          </form.Field>

          <form.Field name="name">
            {(field) => (
              <div className="grid gap-1.5">
                <Label htmlFor="conn-name">Name</Label>
                <Input
                  id="conn-name"
                  placeholder="acme-prod"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                <FieldError errors={field.state.meta.errors} touched={field.state.meta.isTouched} />
              </div>
            )}
          </form.Field>

          <form.Subscribe selector={(s) => s.values.dialect}>
            {(dialect) =>
              dialect === "sqlite" ? (
                <form.Field name="database">
                  {(field) => (
                    <div className="grid gap-1.5">
                      <Label htmlFor="conn-file">Database file</Label>
                      <Input
                        id="conn-file"
                        className="font-mono text-xs"
                        placeholder="/Users/you/data/app.sqlite"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                      />
                      <FieldError errors={field.state.meta.errors} touched={field.state.meta.isTouched} />
                    </div>
                  )}
                </form.Field>
              ) : (
                <>
                  <form.Field name="mode">
                    {(field) => (
                      <Tabs value={field.state.value} onValueChange={(v) => field.handleChange(v as "fields" | "url")}>
                        <TabsList className="w-full">
                          <TabsTrigger value="fields" className="flex-1">Fields</TabsTrigger>
                          <TabsTrigger value="url" className="flex-1">Connection URL</TabsTrigger>
                        </TabsList>
                      </Tabs>
                    )}
                  </form.Field>

                  <form.Subscribe selector={(s) => s.values.mode}>
                    {(mode) =>
                      mode === "url" ? (
                        <form.Field name="url">
                          {(field) => (
                            <div className="grid gap-1.5">
                              <Label htmlFor="conn-url">URL</Label>
                              <Input
                                id="conn-url"
                                className="font-mono text-xs"
                                placeholder={`${dialect === "mysql" ? "mysql" : "postgres"}://user:pass@host:${dialect === "mysql" ? 3306 : 5432}/db`}
                                value={field.state.value}
                                onBlur={field.handleBlur}
                                onChange={(e) => field.handleChange(e.target.value)}
                              />
                              <FieldError errors={field.state.meta.errors} touched={field.state.meta.isTouched} />
                            </div>
                          )}
                        </form.Field>
                      ) : (
                        <div className="grid grid-cols-6 gap-3">
                          <form.Field name="host">
                            {(field) => (
                              <div className="col-span-4 grid gap-1.5">
                                <Label htmlFor="conn-host">Host</Label>
                                <Input id="conn-host" placeholder="localhost" className="font-mono text-xs"
                                  value={field.state.value} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} />
                                <FieldError errors={field.state.meta.errors} touched={field.state.meta.isTouched} />
                              </div>
                            )}
                          </form.Field>
                          <form.Field name="port">
                            {(field) => (
                              <div className="col-span-2 grid gap-1.5">
                                <Label htmlFor="conn-port">Port</Label>
                                <Input id="conn-port" className="font-mono text-xs" inputMode="numeric"
                                  value={field.state.value} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} />
                                <FieldError errors={field.state.meta.errors} touched={field.state.meta.isTouched} />
                              </div>
                            )}
                          </form.Field>
                          <form.Field name="database">
                            {(field) => (
                              <div className="col-span-3 grid gap-1.5">
                                <Label htmlFor="conn-db">Database</Label>
                                <Input id="conn-db" placeholder="acme" className="font-mono text-xs"
                                  value={field.state.value} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} />
                                <FieldError errors={field.state.meta.errors} touched={field.state.meta.isTouched} />
                              </div>
                            )}
                          </form.Field>
                          <form.Field name="user">
                            {(field) => (
                              <div className="col-span-3 grid gap-1.5">
                                <Label htmlFor="conn-user">User</Label>
                                <Input id="conn-user" placeholder="app_ro" className="font-mono text-xs"
                                  value={field.state.value} onBlur={field.handleBlur} onChange={(e) => field.handleChange(e.target.value)} />
                                <FieldError errors={field.state.meta.errors} touched={field.state.meta.isTouched} />
                              </div>
                            )}
                          </form.Field>
                          <form.Field name="password">
                            {(field) => (
                              <div className="col-span-6 grid gap-1.5">
                                <Label htmlFor="conn-pw">Password</Label>
                                <div className="relative">
                                  <Input
                                    id="conn-pw"
                                    type={showPw ? "text" : "password"}
                                    placeholder={editing ? "unchanged" : "••••••••"}
                                    className="pr-9 font-mono text-xs"
                                    value={field.state.value}
                                    onBlur={field.handleBlur}
                                    onChange={(e) => field.handleChange(e.target.value)}
                                  />
                                  <button type="button" onClick={() => setShowPw(!showPw)}
                                    aria-label={showPw ? "Hide password" : "Show password"}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink">
                                    {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                                  </button>
                                </div>
                              </div>
                            )}
                          </form.Field>
                        </div>
                      )
                    }
                  </form.Subscribe>
                </>
              )
            }
          </form.Subscribe>

          <div className="grid grid-cols-2 gap-3">
            <form.Field name="env">
              {(field) => (
                <div className="grid gap-1.5">
                  <Label>Environment</Label>
                  <Select value={field.state.value} onValueChange={(v) => field.handleChange(v as ConnectionEnv)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="local">Local</SelectItem>
                      <SelectItem value="staging">Staging</SelectItem>
                      <SelectItem value="prod">Production</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </form.Field>
            <form.Field name="ssl">
              {(field) => (
                <div className="grid gap-1.5">
                  <Label>SSL</Label>
                  <Select value={field.state.value} onValueChange={(v) => field.handleChange(v as SslMode)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="disable">Disable</SelectItem>
                      <SelectItem value="prefer">Prefer</SelectItem>
                      <SelectItem value="require">Require</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </form.Field>
          </div>

          <form.Field name="readOnlyForAi">
            {(field) => (
              <div className="flex items-center justify-between rounded-md bg-inset px-3 py-2">
                <div>
                  <div className="text-sm font-medium">Read-only for AI</div>
                  <div className="text-xs text-ink-2">Chat can only run SELECT unless you approve a write.</div>
                </div>
                <Switch checked={field.state.value} onCheckedChange={(v) => field.handleChange(Boolean(v))} />
              </div>
            )}
          </form.Field>

          {saveError && (
            <div className="rounded-md bg-danger-tint px-3 py-2 text-xs text-danger">{saveError}</div>
          )}

          <DialogFooter className="min-w-0 sm:justify-between">
            <div className="flex min-w-0 items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void runTest()} disabled={test.state === "testing"}>
                <TestTube2 className={cn(test.state === "testing" && "animate-pulse")} />
                {test.state === "testing" ? "Testing…" : "Test connection"}
              </Button>
              {test.state === "ok" && <span className="min-w-0 truncate text-xs text-success">{test.message}</span>}
              {test.state === "error" && <span className="min-w-0 truncate text-xs text-danger">{test.message}</span>}
            </div>
            <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button type="submit" size="sm" disabled={!canSubmit || isSubmitting}>
                  {isSubmitting ? "Saving…" : editing ? "Save changes" : "Save & connect"}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
