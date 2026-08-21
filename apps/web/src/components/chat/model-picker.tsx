/**
 * Model picker for the prompt bar: the `ai.models` catalog grouped by provider,
 * with a tier pill per row and a "Set as default" footer that writes
 * `settings.defaultModel`.
 *
 * The picker is presentational about *selection only* — the caller owns which
 * model is selected (thread model → user default → server default) and what to
 * do when it changes.
 */
import type { ModelTier } from "@dbchat/contracts";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Sparkles, Star } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { modelsQuery } from "@/rpc/ai";

const TIER_CLASS: Record<ModelTier, string> = {
  fast: "bg-inset text-ink-2",
  balanced: "bg-brand-tint text-brand-ink",
  frontier: "bg-inset text-ink-2",
};

export function TierPill({ tier, className }: { tier: ModelTier; className?: string }) {
  return (
    <span className={cn("rounded-sm px-1 font-mono text-[10.5px]", TIER_CLASS[tier], className)}>{tier}</span>
  );
}

export function ModelPicker({
  value,
  label,
  onChange,
  disabled = false,
}: {
  /** Selected model id (already resolved by the caller). */
  value?: string | undefined;
  /** Short label to show in the bar, e.g. `Sonnet 5`. */
  label: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}) {
  const { data: catalog } = useQuery(modelsQuery);
  const defaultModel = useSettings((s) => s.defaultModel);
  const setDefaultModel = useSettings((s) => s.setDefaultModel);
  const isDefault = Boolean(value) && defaultModel === value;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Model: ${label}`}
        className="flex items-center gap-1 whitespace-nowrap rounded-sm px-1 py-0.5 text-[11px] text-ink-3 hover:bg-hover hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-50"
      >
        <Sparkles className="size-3 text-brand" />
        {label}
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-72 min-w-72">
        {(catalog ?? []).map((provider) => {
          const unavailable = provider.status !== "ready";
          return (
            <DropdownMenuGroup key={provider.provider}>
              <DropdownMenuLabel className={cn("flex items-center gap-1.5", unavailable && "opacity-60")}>
                {provider.label}
                {unavailable && (
                  <span className="truncate text-[10.5px] text-ink-3">
                    — {provider.reason ?? "unavailable"}
                  </span>
                )}
              </DropdownMenuLabel>
              {provider.models.map((m) => (
                <DropdownMenuItem
                  key={m.id}
                  disabled={unavailable}
                  onClick={() => onChange(m.id)}
                  className="items-start gap-2 py-1.5"
                >
                  <Check className={cn("mt-0.5 size-3.5 shrink-0", m.id === value ? "text-brand" : "opacity-0")} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{m.label}</span>
                      <TierPill tier={m.tier} />
                      {m.default && <span className="text-[10.5px] text-ink-3">server default</span>}
                    </span>
                    {m.description && (
                      <span className="mt-0.5 block text-[11px] leading-snug text-ink-3">{m.description}</span>
                    )}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          );
        })}
        {catalog && catalog.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem
          disabled={!value || isDefault}
          onClick={() => value && setDefaultModel(value)}
          className="gap-2"
        >
          <Star className={cn("size-3.5", isDefault && "fill-brand text-brand")} />
          {isDefault ? `${label} is your default` : "Set as default"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
