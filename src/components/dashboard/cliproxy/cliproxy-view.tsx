import { useState } from "react"
import useSWR from "swr"
import { Link } from "react-router"
import { toast } from "sonner"
import { apiFetch, fetcher } from "@/components/dashboard/api"
import type { CliproxyInstanceStatus, CliproxyVersions } from "@/lib/cliproxy/types"
import { createInstallAction } from "@/lib/cliproxy/page-state"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Confirmation } from "./confirmation"
import { ManagedKeys, AuthFiles } from "./credentials"
import { GlobalOauth } from "./oauth"
import { EngineLogs } from "./logs"

type Action = { action: "install" | "start" | "stop" | "restart"; version?: string; title: string }

export function CliproxyView() {
  const [pending, setPending] = useState(false)
  const [action, setAction] = useState<Action | null>(null)
  const [error, setError] = useState<string>()
  const status = useSWR<CliproxyInstanceStatus>("/api/admin/cliproxy/status", fetcher, { refreshInterval: pending ? 1500 : 5000 })
  const versions = useSWR<CliproxyVersions>(status.data?.mode === "managed" ? "/api/admin/cliproxy/versions" : null, fetcher, { revalidateOnFocus: false, errorRetryCount: 1 })
  const [selected, setSelected] = useState<string>("")
  const blocked = pending || Boolean(status.data?.operation) || Boolean(status.data?.conflict) || !status.data || Boolean(status.error)
  async function run() {
    if (!action) return
    setPending(true); setError(undefined)
    try {
      await apiFetch(`/api/admin/cliproxy/service/${action.action}`, { method: "POST", ...(action.version ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ version: action.version }) } : {}) })
      toast.success("CLIProxy operation completed"); setAction(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "CLIProxy operation failed."); setAction(null) }
    finally { setPending(false); void status.mutate(); void versions.mutate() }
  }
  function install(version: string) {
    const choice = createInstallAction(version, versions.data?.latest ?? null, status.data?.version ?? null)
    setAction({ action: "install", version, title: `${choice.downgrade ? "Downgrade to" : "Install"} CLIProxyAPI ${choice.version}?` })
  }
  const service = status.data
  return <div className="space-y-6">
    <ServiceCard service={service} error={status.error} actionError={error} blocked={blocked} refresh={() => void status.mutate()} choose={setAction} />
    {service?.mode === "managed" && <ReleasesCard data={versions.data} error={versions.error} refreshing={versions.isValidating} blocked={blocked} selected={selected} select={setSelected} refresh={() => void versions.mutate()} install={install} />}
    <Card><CardHeader><CardTitle>Connection</CardTitle><CardDescription>Use a workspace gateway key with the public URL below.</CardDescription></CardHeader><CardContent><p className="break-all font-mono text-sm">{window.location.origin}/v1</p><Button variant="outline" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/v1`).then(() => toast.success("Base URL copied")).catch(() => toast.error("Unable to copy URL"))}>Copy base URL</Button></CardContent></Card>
    <ManagedKeys /><GlobalOauth /><AuthFiles /><EngineLogs />
    <Confirmation title={action?.title ?? null} pending={pending} onClose={() => setAction(null)} onConfirm={() => void run()} description={action?.action === "stop" ? "Provider requests that use CLIProxyAPI will be unavailable until you start it again. If requests cannot drain, the service remains running." : "This changes the shared service for every workspace. Release changes may briefly interrupt availability; failed startup restores the previous version and configuration."} />
  </div>
}

function ServiceCard({ service, error, actionError, blocked, refresh, choose }: { service?: CliproxyInstanceStatus; error: unknown; actionError?: string; blocked: boolean; refresh: () => void; choose: (action: Action) => void }) {
  return <Card><CardHeader><CardTitle>CLIProxyAPI</CardTitle><CardDescription>Shared provider engine for all workspaces. <Link to="/dashboard/settings" className="underline">Gateway settings</Link> · <Link to="/dashboard/system-logs" className="underline">System Logs</Link></CardDescription></CardHeader><CardContent><div className="space-y-4">
      {error ? <p role="alert">Unable to load CLIProxy status. <Button variant="outline" onClick={refresh}>Retry status</Button></p> : !service ? <p role="status">Loading service status…</p> : <>
        <ServiceDetails service={service} blocked={blocked} refresh={refresh} choose={choose} />
      </>}
      {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
    </div></CardContent></Card>
}

function ReleasesCard({ data, error, refreshing, blocked, selected, select, refresh, install }: { data?: CliproxyVersions; error: unknown; refreshing: boolean; blocked: boolean; selected: string; select: (value: string) => void; refresh: () => void; install: (version: string) => void }) {
  return <Card><CardHeader><CardTitle>Releases</CardTitle><CardDescription>Install a release or pin an exact version. Running requests finish before service changes.</CardDescription></CardHeader><CardContent><div className="space-y-4">
      {Boolean(error) && <p role="alert">Unable to refresh releases.{data ? " Showing cached releases." : " Check network access to GitHub."}</p>}
      <div className="flex flex-wrap gap-2"><Button disabled={blocked || !data} onClick={() => install("latest")}>{data ? `Install latest (${data.latest})` : "Loading releases…"}</Button><Button variant="outline" disabled={refreshing} onClick={refresh}>Refresh releases</Button></div>
      <Field><FieldLabel htmlFor="cliproxy-release">Exact release</FieldLabel><div className="flex flex-wrap gap-2"><Select value={selected} onValueChange={value => select(value ?? "")}><SelectTrigger id="cliproxy-release"><SelectValue placeholder="Choose version" /></SelectTrigger><SelectContent>{data?.versions.map(release => <SelectItem key={release.version} value={release.version}>{release.version}</SelectItem>)}</SelectContent></Select><Button variant="outline" disabled={blocked || !selected} onClick={() => install(selected)}>Install selected version</Button></div></Field>
    </div></CardContent></Card>
}

function ServiceDetails({ service, blocked, refresh, choose }: { service: CliproxyInstanceStatus; blocked: boolean; refresh: () => void; choose: (action: Action) => void }) {
  return <>
        <div className="flex flex-wrap items-center gap-2"><Badge variant={service.healthy ? "default" : "secondary"}>{service.healthy ? "Healthy" : service.processRunning ? "Unhealthy" : "Stopped"}</Badge><Badge variant="outline">{service.mode === "managed" ? "Managed by RawRoute" : "External instance"}</Badge>{service.operation && <Badge>{service.operation.name}</Badge>}</div>
        <dl className="grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-muted-foreground">Installed version</dt><dd>{service.version ?? (service.mode === "external" ? "Managed externally" : "Not installed")}</dd></div><div><dt className="text-muted-foreground">Selected release</dt><dd>{service.pinnedVersion ?? "Latest"}</dd></div><div><dt className="text-muted-foreground">Active requests</dt><dd>{service.activeRequests}</dd></div><div><dt className="text-muted-foreground">Recovery attempts</dt><dd>{service.restartAttempts}</dd></div></dl>
        {service.lastError && <p role="alert" className="break-words text-sm text-destructive">{service.lastError}</p>}
        <ServiceControls service={service} blocked={blocked} refresh={refresh} choose={choose} />
  </>
}

function ServiceControls({ service, blocked, refresh, choose }: { service: CliproxyInstanceStatus; blocked: boolean; refresh: () => void; choose: (action: Action) => void }) {
  return <> {service.mode === "managed" ? <div className="flex flex-wrap gap-2"><Button disabled={blocked || !service.installed || service.processRunning} onClick={() => choose({ action: "start", title: "Start CLIProxyAPI?" })}>Start</Button><Button variant="outline" disabled={blocked || !service.installed} onClick={() => choose({ action: "restart", title: "Restart CLIProxyAPI?" })}>Restart</Button><Button variant="destructive" disabled={blocked || !service.processRunning && !service.desiredRunning} onClick={() => choose({ action: "stop", title: "Stop CLIProxyAPI?" })}>Stop</Button><Button variant="outline" onClick={refresh}>Refresh status</Button></div> : <p className="text-sm text-muted-foreground">Process and release changes are controlled by your external deployment. Global credentials, OAuth, logs, and settings remain available here.</p>} </>
}
