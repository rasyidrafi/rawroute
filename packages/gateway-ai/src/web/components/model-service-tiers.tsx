import type { ModelServiceTierCapability } from "../../contracts/domain"
import { profileTiers, serviceTierLabel } from "../../contracts/service-tier"
import { Checkbox } from "@rawroute/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@rawroute/ui/select"

export function ModelServiceTiers({ value, onChange }: { value: ModelServiceTierCapability; onChange: (value: ModelServiceTierCapability) => void }) {
  const supported = new Set(value.supportedTiers)
  return <section className="grid gap-3 rounded-lg border p-3" aria-label="Service tiers">
    <div><div className="text-sm font-medium">Service tiers</div><p className="text-xs text-muted-foreground">Declare upstream support for this provider model. This does not force a tier on requests. Set prices separately in Model Pricing.</p></div>
    <label className="grid gap-2 text-sm">Detection profile
      <Select value={value.profile} onValueChange={profile => { if (profile === "openai" || profile === "anthropic") onChange({ profile, supportedTiers: [] }) }}>
        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="openai">OpenAI · service_tier</SelectItem><SelectItem value="anthropic">Anthropic · speed</SelectItem></SelectContent>
      </Select>
    </label>
    <div className="flex flex-wrap gap-4"><span className="text-sm text-muted-foreground">Standard · always supported</span>{profileTiers(value.profile).map(tier => <label key={tier} className="flex items-center gap-2 text-sm"><Checkbox checked={supported.has(tier)} onCheckedChange={checked => onChange({ ...value, supportedTiers: checked ? [...value.supportedTiers, tier] : value.supportedTiers.filter(entry => entry !== tier) })} />{serviceTierLabel(tier)}</label>)}</div>
    <p className="text-xs text-muted-foreground">{value.profile === "anthropic" ? "Fast mode uses speed / usage.speed. Anthropic Priority capacity is separate from Fast mode." : "Fast accepts fast or priority. The reported response tier takes precedence over the requested tier."} Requests remain pass-through; actual upstream support is verified by the provider.</p>
  </section>
}
