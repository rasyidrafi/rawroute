import { GatewaySettingsCard } from "./settings-layout"
import { SettingsFields } from "./settings-fields"
import { InstanceSettingsSkeleton } from "./settings-skeleton"
import { useState, type FormEvent } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { apiPatch, fetcher } from "@/components/dashboard/api"
import type { InstanceSettings } from "@/lib/instance-settings"
import { instanceSettingsSchema } from "@/lib/instance-settings"
import { Button } from "@/components/ui/button"
import { LoadingSpinner } from "@/components/loading-spinner"

export function InstanceSettingsCard() {
  const { data, error, isLoading, mutate } = useSWR<InstanceSettings>("/api/admin/settings", fetcher)
  return <GatewaySettingsCard>
    {isLoading ? <InstanceSettingsSkeleton /> : error ? <div role="alert"><p>Unable to load gateway settings. Password settings remain available.</p><Button variant="outline" onClick={() => void mutate()}>Retry</Button></div> : data ? <InstanceSettingsForm key={JSON.stringify(data)} initial={data} onSaved={() => mutate()} /> : null}
  </GatewaySettingsCard>
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
  return <form onSubmit={submit}><SettingsFields value={value} disabled={pending} onChange={patch => setValue(current => ({ ...current, ...patch }))} footer={<>
    {error && <p role="alert" className="w-full text-sm text-destructive">{error}</p>}
    <Button disabled={pending} type="submit">{pending && <LoadingSpinner />}Save settings</Button>
  </>} /></form>
}
