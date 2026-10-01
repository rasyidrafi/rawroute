import { CliProxySettingsCard } from "./settings-layout"
import { SettingsFields } from "./settings-fields"
import { CliProxySettingsSkeleton } from "./settings-skeleton"
import { useState, type FormEvent } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { apiPatch, fetcher } from "@/components/dashboard/api"
import type { CliProxySettings } from "@/lib/cliproxy/settings"
import { cliproxySettingsSchema } from "@/lib/cliproxy/settings"
import { Button } from "@/components/ui/button"
import { LoadingSpinner } from "@/components/loading-spinner"

export function CliProxySettingsResource() {
  const { data, error, isLoading, mutate } = useSWR<CliProxySettings>("/api/admin/cliproxy/settings", fetcher)
  return <CliProxySettingsCard>
    {isLoading ? <CliProxySettingsSkeleton /> : error ? <div role="alert"><p>Unable to load CLIProxyAPI settings.</p><Button variant="outline" onClick={() => void mutate()}>Retry</Button></div> : data ? <CliProxySettingsForm key={JSON.stringify(data)} initial={data} onSaved={() => mutate()} /> : null}
  </CliProxySettingsCard>
}

function CliProxySettingsForm({ initial, onSaved }: { initial: CliProxySettings; onSaved: () => Promise<unknown> }) {
  const [value, setValue] = useState(initial)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = cliproxySettingsSchema.safeParse(value)
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Invalid settings."); return }
    setPending(true)
    setError(undefined)
    try { await apiPatch("/api/admin/cliproxy/settings", { debug: parsed.data.debug, loggingToFile: parsed.data.loggingToFile, usageStatisticsEnabled: parsed.data.usageStatisticsEnabled, requestRetry: parsed.data.requestRetry, maxRetryInterval: parsed.data.maxRetryInterval }); await onSaved(); toast.success("CLIProxyAPI settings saved") }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save settings.") }
    finally { setPending(false) }
  }
  return <form onSubmit={submit}><SettingsFields value={value} disabled={pending} onChange={patch => setValue(current => ({ ...current, ...patch }))} footer={<>
    {error && <p role="alert" className="w-full text-sm text-destructive">{error}</p>}
    <Button disabled={pending} type="submit">{pending && <LoadingSpinner />}Save settings</Button>
  </>} /></form>
}
