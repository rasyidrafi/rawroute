import type { ReactNode } from "react"
import type { CliProxySettings } from "@/lib/cliproxy/settings"
import { Badge } from "@/components/ui/badge"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"

const toggles = [
  { key: "debug", label: "Debug logging", description: "Include detailed diagnostic messages." },
  { key: "loggingToFile", label: "File logging", description: "Write engine logs to files." },
  { key: "usageStatisticsEnabled", label: "Usage statistics", description: "Collect request and token usage statistics." },
] as const

export function SettingsFields({ value, disabled = false, onChange, footer }: { value?: CliProxySettings; disabled?: boolean; onChange?: (patch: Partial<CliProxySettings>) => void; footer: ReactNode }) {
  return <div className="space-y-6" aria-busy={!value}>
    <section className="space-y-3" aria-labelledby="logging-heading"><h2 id="logging-heading" className="text-sm font-semibold">Logging &amp; statistics</h2><div className="divide-y rounded-lg border px-4">{toggles.map(({ key, label, description }) => <div key={key} className="flex items-center justify-between gap-4 py-4"><div className="min-w-0 space-y-1"><FieldLabel htmlFor={`settings-${key}`}>{label}</FieldLabel><p className="text-xs text-muted-foreground">{description}</p></div>{value ? <Switch id={`settings-${key}`} aria-label={label} checked={value[key]} disabled={disabled} onCheckedChange={checked => onChange?.({ [key]: checked })} /> : <Skeleton shape="pill" className="h-5 w-9 shrink-0" />}</div>)}</div></section>
    <section className="space-y-3" aria-labelledby="retry-heading"><h2 id="retry-heading" className="text-sm font-semibold">Request retries</h2><div className="grid items-end gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="request-retry">Request retry count</FieldLabel>{value ? <Input id="request-retry" type="number" min={0} max={100} required value={value.requestRetry} disabled={disabled} onChange={event => onChange?.({ requestRetry: Number(event.target.value) })} /> : <Skeleton className="h-8 w-full" />}</Field><Field><FieldLabel htmlFor="retry-interval">Maximum retry interval (seconds)</FieldLabel>{value ? <Input id="retry-interval" type="number" min={0} max={3600} required value={value.maxRetryInterval} disabled={disabled} onChange={event => onChange?.({ maxRetryInterval: Number(event.target.value) })} /> : <Skeleton className="h-8 w-full" />}</Field></div></section>
    <section className="space-y-2 rounded-lg border bg-muted/20 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 id="routing-heading" className="text-sm font-semibold">Routing strategy</h2>{value ? <Badge variant="outline" aria-label="Routing strategy">{value.routingStrategy}</Badge> : <Skeleton className="h-5 w-20" />}</div><p className="text-xs text-muted-foreground">RawRoute manages fill-first routing to preserve provider key priority.</p></section>
    <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4">{footer}</div>
  </div>
}
