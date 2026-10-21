import type { PricingContextTier, PricingRates, PricingServiceTier } from "../../contracts/domain"
import { serviceTierLabel } from "../../contracts/service-tier"
import { Button } from "@rawroute/ui/button"
import { Input } from "@rawroute/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@rawroute/ui/select"

const fields = [["inputMicrosPerMillion", "Input"], ["outputMicrosPerMillion", "Output"], ["cacheReadMicrosPerMillion", "Cache read"], ["cacheCreationMicrosPerMillion", "Cache creation"]] as const

function RateInputs({ rates, onChange, label }: { rates: PricingRates; onChange: (rates: PricingRates) => void; label: string }) {
  return <div className="grid gap-3 sm:grid-cols-2">{fields.map(([field, name]) => <label key={field} className="grid gap-1 text-xs">{name} · USD / 1M<Input aria-label={`${label} ${name}`} type="number" min="0" step="any" value={Number.isFinite(rates[field]) ? rates[field] / 1_000_000 : ""} onChange={event => onChange({ ...rates, [field]: event.target.value === "" ? NaN : Math.round(Number(event.target.value) * 1_000_000) })} /></label>)}</div>
}

export function ServiceTierEditor({ tiers, supported, catalog = [], standard, contexts, onChange, disabled }: { tiers: PricingServiceTier[]; supported: string[]; catalog?: PricingServiceTier[]; standard: PricingRates; contexts: PricingContextTier[]; onChange: (tiers: PricingServiceTier[]) => void; disabled: boolean }) {
  const names = [...new Set([...supported, ...tiers.map(tier => tier.serviceTier), ...catalog.map(tier => tier.serviceTier)])]
  function update(tier: PricingServiceTier) { onChange([...tiers.filter(entry => entry.serviceTier !== tier.serviceTier), tier]) }
  return <fieldset disabled={disabled} className="grid min-w-0 gap-3 rounded-lg border p-3">
    <legend className="px-1 text-sm font-medium">Service tier pricing</legend>
    <p className="text-xs text-muted-foreground">Standard uses the rates above. Enable supported tiers in Provider Detail → Edit model. These prices are shared by every model in this pricing group; use separate groups for different provider rates. Unconfigured tiers remain unpriced.</p>
    {!names.length && <p className="text-sm text-muted-foreground">No service tiers configured. Select supported tiers on the provider model to configure their prices here. A catalog link is optional.</p>}
    {names.map(name => {
      const tier = tiers.find(entry => entry.serviceTier === name)
      const imported = catalog.find(entry => entry.serviceTier === name)
      return <section key={name} aria-label={`${serviceTierLabel(name)} pricing`} className="grid gap-3 rounded-md border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><div className="text-sm font-medium">{serviceTierLabel(name)} <span className="font-normal text-muted-foreground">· {tier ? tier.source === "catalog" ? "Imported" : "Custom" : "Not configured"}</span></div>
          <div className="flex flex-wrap gap-2">{imported && <Button type="button" size="sm" variant="outline" onClick={() => update({ ...imported, source: "catalog" })}>Use catalog rates</Button>}{tier ? <Button type="button" size="sm" variant="ghost" onClick={() => onChange(tiers.filter(entry => entry.serviceTier !== name))}>Remove rates</Button> : <Button type="button" size="sm" variant="outline" onClick={() => update({ serviceTier: name, ...standard, contextTiers: contexts, source: "custom", multiplier: 1 })}>Configure rates</Button>}</div>
        </div>
        {tier && <>
          <label className="grid gap-1 text-xs">Pricing method<Select value={tier.multiplier === undefined ? "rates" : "multiplier"} onValueChange={value => update({ ...tier, source: "custom", multiplier: value === "multiplier" ? 1 : undefined })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="rates">Custom rates per token component</SelectItem><SelectItem value="multiplier">Multiplier of Standard</SelectItem></SelectContent></Select></label>
          {tier.multiplier !== undefined ? <label className="grid gap-1 text-xs">Multiplier · includes Standard context thresholds<Input aria-label={`${serviceTierLabel(name)} multiplier`} type="number" min="0" step="any" value={Number.isFinite(tier.multiplier) ? tier.multiplier : ""} onChange={event => update({ ...tier, source: "custom", multiplier: event.target.value === "" ? NaN : Number(event.target.value) })} /></label> : <>
            <RateInputs rates={tier} label={serviceTierLabel(name)} onChange={rates => update({ ...tier, ...rates, source: "custom" })} />
            {tier.contextTiers.map(context => <div key={context.id} className="grid gap-2 rounded-md bg-muted/30 p-3"><label className="grid gap-1 text-xs">From input tokens<Input aria-label={`${serviceTierLabel(name)} context threshold`} type="number" min="1" step="1" value={context.thresholdTokens} onChange={event => update({ ...tier, source: "custom", contextTiers: tier.contextTiers.map(entry => entry.id === context.id ? { ...entry, thresholdTokens: Number(event.target.value) } : entry) })} /></label><RateInputs rates={context} label={`${serviceTierLabel(name)} context ${context.thresholdTokens}`} onChange={rates => update({ ...tier, source: "custom", contextTiers: tier.contextTiers.map(entry => entry.id === context.id ? { ...context, ...rates } : entry) })} /><Button type="button" variant="ghost" size="sm" onClick={() => update({ ...tier, source: "custom", contextTiers: tier.contextTiers.filter(entry => entry.id !== context.id) })}>Remove context threshold</Button></div>)}
            <Button type="button" variant="outline" size="sm" onClick={() => update({ ...tier, source: "custom", contextTiers: [...tier.contextTiers, { id: crypto.randomUUID(), thresholdTokens: 32000, inputMicrosPerMillion: tier.inputMicrosPerMillion, outputMicrosPerMillion: tier.outputMicrosPerMillion, cacheReadMicrosPerMillion: tier.cacheReadMicrosPerMillion, cacheCreationMicrosPerMillion: tier.cacheCreationMicrosPerMillion }] })}>Add context threshold</Button>
          </>}
        </>}
      </section>
    })}
  </fieldset>
}
