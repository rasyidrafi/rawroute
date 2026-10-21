import type { PricingServiceTier } from "../../contracts/domain"
import { serviceTierLabel } from "../../contracts/service-tier"
import { formatCost } from "../../contracts/usage-display"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@rawroute/ui/table"

export function ServiceTierRates({ tiers = [] }: { tiers?: PricingServiceTier[] }) {
  return <div className="min-w-0 space-y-2">
    <div className="text-sm font-medium">Service tier pricing</div>
    <p className="text-xs text-muted-foreground">{tiers.length ? "USD per 1M tokens. Catalog rates are suggestions; custom schedules are preserved on catalog refresh." : "This catalog entry has no tier rates. Configure supported tiers on the provider model and set their rates in Pricing."}</p>
    <Table><TableHeader><TableRow><TableHead>Tier / context</TableHead><TableHead>Input</TableHead><TableHead>Output</TableHead><TableHead>Cache read</TableHead><TableHead>Cache creation</TableHead></TableRow></TableHeader><TableBody>{tiers.flatMap(tier => [{ ...tier, label: serviceTierLabel(tier.serviceTier), key: tier.serviceTier }, ...tier.contextTiers.map(context => ({ ...context, label: `${serviceTierLabel(tier.serviceTier)} · from ${context.thresholdTokens.toLocaleString()} tokens`, key: `${tier.serviceTier}:${context.id}` }))]).map(row => <TableRow key={row.key}><TableCell>{row.label}</TableCell><TableCell>{formatCost(row.inputMicrosPerMillion)}</TableCell><TableCell>{formatCost(row.outputMicrosPerMillion)}</TableCell><TableCell>{formatCost(row.cacheReadMicrosPerMillion)}</TableCell><TableCell>{formatCost(row.cacheCreationMicrosPerMillion)}</TableCell></TableRow>)}</TableBody></Table>
  </div>
}
