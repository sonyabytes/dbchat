import type { ModelTier } from "@dbchat/contracts";

import { cn } from "@/lib/utils";

const TIER_CLASS: Record<ModelTier, string> = {
  fast: "bg-inset text-ink-2",
  balanced: "bg-brand-tint text-brand-ink",
  frontier: "bg-inset text-ink-2",
};

export function TierPill({ tier, className }: { tier: ModelTier; className?: string }) {
  return <span className={cn("rounded-sm px-1 font-mono text-[10.5px]", TIER_CLASS[tier], className)}>{tier}</span>;
}
