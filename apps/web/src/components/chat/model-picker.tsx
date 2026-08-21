import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Search, Sparkles, Star } from "lucide-react";
import { useState } from "react";

import { TierPill } from "@/components/chat/tier-pill";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { modelsQuery } from "@/rpc/ai";

export { TierPill } from "./tier-pill";

export function ModelPicker({ value, label, onChange, disabled = false }: {
  value?: string | undefined;
  label: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}) {
  const { data: catalog } = useQuery(modelsQuery);
  const defaultModel = useSettings((state) => state.defaultModel);
  const setDefaultModel = useSettings((state) => state.setDefaultModel);
  const [open, setOpen] = useState(false);
  const isDefault = Boolean(value) && defaultModel === value;

  const choose = (modelId: string) => {
    onChange(modelId);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={`Model: ${label}`}
        render={
          <button type="button" className="flex items-center gap-1 whitespace-nowrap rounded-sm px-1 py-0.5 text-[11px] text-ink-3 hover:bg-hover hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-50">
            <Sparkles className="size-3 text-brand" />
            {label}
            <ChevronDown className="size-3" />
          </button>
        }
      />
      <PopoverContent align="end" side="top" className="w-[min(24rem,calc(100vw-2rem))] gap-0 p-0">
        <Command>
          <CommandInput placeholder="Search models or providers…" />
          <CommandList className="max-h-80">
            <CommandEmpty><Search className="mx-auto mb-2 text-muted-foreground" />No matching models</CommandEmpty>
            {(catalog ?? []).map((provider) => {
              const unavailable = provider.status !== "ready";
              return (
                <CommandGroup key={provider.provider} heading={`${provider.label}${unavailable ? " · unavailable" : ""}`}>
                  {provider.models.map((model) => (
                    <CommandItem
                      key={model.id}
                      value={`${provider.label} ${model.label} ${model.id} ${model.tier}`}
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
                        {unavailable ? <span className="mt-0.5 block text-muted-foreground">{provider.reason}</span> : null}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
            <CommandSeparator />
            <div className="p-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={!value || isDefault}
                onClick={() => value && setDefaultModel(value)}
                className="w-full justify-start"
              >
                <Star className={cn(isDefault && "fill-brand text-brand")} />
                {isDefault ? `${label} is your default` : "Set selected model as default"}
              </Button>
            </div>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
