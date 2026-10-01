import { useState, type FormEvent } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { apiPatch, fetcher } from "@/components/dashboard/api"
import type { InstanceSettings } from "@/lib/instance-settings"
import { instanceSettingsSchema } from "@/lib/instance-settings"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { LoadingSpinner } from "@/components/loading-spinner"

export function InstanceSettingsCard() {
  const { data, error, isLoading, mutate } = useSWR<InstanceSettings>("/api/admin/settings", fetcher)
  return <Card className="max-w-2xl"><CardHeader><CardTitle>Global gateway settings</CardTitle><CardDescription>These settings apply to the shared CLIProxy service across every workspace.</CardDescription></CardHeader><CardContent>
    {isLoading ? <p role="status">Loading settings...</p> : error ? <div role="alert"><p>Unable to load gateway settings. Password settings remain available.</p><Button variant="outline" onClick={() => void mutate()}>Retry</Button></div> : data ? <InstanceSettingsForm key={JSON.stringify(data)} initial={data} onSaved={() => mutate()} /> : null}
  </CardContent></Card>
}

function InstanceSettingsForm({ initial, onSaved }: { initial: InstanceSettings; onSaved: () => Promise<unknown> }) {
  const [value, setValue] = useState(initial)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = instanceSettingsSchema.safeParse(value)
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Invalid settings."); return }
    setPending(true)
    setError(undefined)
    try { await apiPatch("/api/admin/settings", { debug: parsed.data.debug, loggingToFile: parsed.data.loggingToFile, usageStatisticsEnabled: parsed.data.usageStatisticsEnabled, requestRetry: parsed.data.requestRetry, maxRetryInterval: parsed.data.maxRetryInterval }); await onSaved(); toast.success("Global settings saved") }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save settings.") }
    finally { setPending(false) }
  }
  return <form onSubmit={submit}><FieldGroup>
    {([['debug', 'Debug logging'], ['loggingToFile', 'File logging'], ['usageStatisticsEnabled', 'Usage statistics']] as const).map(([key, label]) => <Field key={key} orientation="horizontal"><Checkbox id={`settings-${key}`} checked={value[key]} disabled={pending} onCheckedChange={checked => setValue(current => ({ ...current, [key]: checked }))} /><FieldLabel htmlFor={`settings-${key}`}>{label}</FieldLabel></Field>)}
    <Field><FieldLabel htmlFor="request-retry">Request retry count</FieldLabel><Input id="request-retry" type="number" min={0} max={100} required value={value.requestRetry} disabled={pending} onChange={event => setValue(current => ({ ...current, requestRetry: Number(event.target.value) }))} /></Field>
    <Field><FieldLabel htmlFor="retry-interval">Maximum retry interval (seconds)</FieldLabel><Input id="retry-interval" type="number" min={0} max={3600} required value={value.maxRetryInterval} disabled={pending} onChange={event => setValue(current => ({ ...current, maxRetryInterval: Number(event.target.value) }))} /></Field>
    <Field><FieldLabel htmlFor="routing-strategy">Routing strategy</FieldLabel><Input id="routing-strategy" readOnly value={initial.routingStrategy} /><p className="text-sm text-muted-foreground">RawRoute manages fill-first routing to preserve provider key priority.</p></Field>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div><Button disabled={pending} type="submit">{pending && <LoadingSpinner />}Save settings</Button></div>
  </FieldGroup></form>
}
