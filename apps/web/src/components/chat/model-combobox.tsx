import type { ProviderId, ProviderModels } from "@dbchat/contracts";
import { Check, ChevronsUpDown, Search, Sparkles } from "lucide-react";
import { useState } from "react";

import { TierPill } from "@/components/chat/tier-pill";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { findModel } from "@/rpc/ai";

export function ModelCombobox({
  catalog,
  value,
  onChange,
  includeServerDefault = false,
  serverDefaultLabel,
  align = "end",
  side = "bottom",
  provider,
}: {
  catalog: ReadonlyArray<ProviderModels> | undefined;
  value: string | null | undefined;
  onChange: (modelId: string | null) => void;
  includeServerDefault?: boolean;
  serverDefaultLabel?: string | undefined;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right" | "inline-start" | "inline-end";
  /** Only list this provider's models. */
  provider?: ProviderId | undefined;
}) {
  const providers = (catalog ?? []).filter((p) => !provider || p.provider === provider);
  const [open, setOpen] = useState(false);
  const selected = findModel(catalog, value);
  const label = selected?.label ?? (includeServerDefault ? `Server default${serverDefaultLabel ? ` · ${serverDefaultLabel}` : ""}` : "Choose a model");

  const choose = (modelId: string | null) => {
    onChange(modelId);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" role="combobox" aria-expanded={open} className="h-auto min-h-8 w-full max-w-80 justify-between px-3 py-1.5 font-normal">
            <span className="flex min-w-0 items-center gap-2">
              <Sparkles className="text-brand" />
              <span className="truncate">{label}</span>
              {selected ? <TierPill tier={selected.tier} /> : null}
            </span>
            <ChevronsUpDown className="text-muted-foreground" />
          </Button>
        }
      />
      <PopoverContent align={align} side={side} className="w-[min(24rem,calc(100vw-2rem))] gap-0 p-0">
        <Command>
          <CommandInput placeholder="Search models or providers…" />
          <CommandList className="max-h-80">
            <CommandEmpty>
              <Search className="mx-auto mb-2 text-muted-foreground" />
              No matching models
            </CommandEmpty>
            {includeServerDefault ? (
              <CommandGroup heading="Default">
                <CommandItem value="server default" data-checked={!value} onSelect={() => choose(null)}>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">Server default</span>
                    {serverDefaultLabel ? <span className="block text-muted-foreground">Currently {serverDefaultLabel}</span> : null}
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {providers.map((group) => {
              const unavailable = group.status !== "ready";
              return (
                <CommandGroup key={group.provider} heading={`${group.label}${unavailable ? " · unavailable" : ""}`}>
                  {group.models.map((model) => (
                    <CommandItem
                      key={model.id}
                      value={`${group.label} ${model.label} ${model.id} ${model.tier}`}
                      disabled={unavailable}
                      data-checked={model.id === value}
                      onSelect={() => choose(model.id)}
                      className="items-start py-2"
                    >
                      <Check className={cn("mt-0.5", model.id === value ? "opacity-100" : "opacity-0")} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium">{model.label}</span>
                          <TierPill tier={model.tier} />
                          {model.default ? <span className="text-muted-foreground">server default</span> : null}
                        </span>
                        {model.description ? <span className="mt-0.5 block text-muted-foreground">{model.description}</span> : null}
                        {unavailable ? <span className="mt-0.5 block text-muted-foreground">{group.reason}</span> : null}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
