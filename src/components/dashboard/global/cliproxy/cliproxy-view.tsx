import { CliProxySkeleton } from "./skeleton"
import { DashboardPage } from "@/components/dashboard/page-layout"
import { useState } from "react"
import useSWR from "swr"
import { CliProxyHeader, Detail, ServiceDetailsSkeleton, ServiceHeaderFrame } from "./source-layout"
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
import { CliproxyManagementPanel } from "./management-panel"

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
  if (!service && !status.error) return <CliProxySkeleton />
  return <DashboardPage spacing="normal">
    <CliProxyHeader refreshing={status.isValidating || pending} refresh={() => void status.mutate()} />
    <ServiceCard service={service} error={status.error} actionError={error} blocked={blocked} refresh={() => void status.mutate()} choose={setAction}>
      {service?.mode === "managed" && <ReleasesCard data={versions.data} error={versions.error} refreshing={versions.isValidating} blocked={blocked} selected={selected} select={setSelected} refresh={() => void versions.mutate()} install={install} />}
    </ServiceCard>
    <ConnectionDetails service={service} />
    <CliproxyManagementPanel />
    <Confirmation title={action?.title ?? null} pending={pending} onClose={() => setAction(null)} onConfirm={() => void run()} description={action?.action === "stop" ? "Provider requests that use CLIProxyAPI will be unavailable until you start it again. If requests cannot drain, the service remains running." : "This changes the shared service for every workspace. Release changes may briefly interrupt availability; failed startup restores the previous version and configuration."} />
  </DashboardPage>
}

function ServiceCard({ service, error, actionError, blocked, refresh, choose, children }: { service?: CliproxyInstanceStatus; error: unknown; actionError?: string; blocked: boolean; refresh: () => void; choose: (action: Action) => void; children: React.ReactNode }) {
  return <Card><CardHeader><ServiceHeaderFrame title={<><span>{service?.mode === "external" ? "External instance" : "Managed process"}</span><Badge variant={service?.conflict || service?.lastError ? "destructive" : "outline"}>{service?.operation?.name ?? (service?.conflict ? "Conflict" : service?.healthy ? "Running" : service?.processRunning ? "Unhealthy" : "Stopped")}</Badge></>} controls={service?.mode === "managed" ? <ServiceControls service={service} blocked={blocked} choose={choose} /> : undefined} /></CardHeader><CardContent><div className="flex min-w-0 flex-col gap-5">
    {error ? <p role="alert">Unable to load CLIProxy status. <Button variant="outline" onClick={refresh}>Retry status</Button></p> : !service ? <ServiceDetailsSkeleton /> : <ServiceDetails service={service} />}
    {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
    {children}
  </div></CardContent></Card>
}

function ReleasesCard({ data, error, refreshing, blocked, selected, select, refresh, install }: { data?: CliproxyVersions; error: unknown; refreshing: boolean; blocked: boolean; selected: string; select: (value: string) => void; refresh: () => void; install: (version: string) => void }) {
  return <div className="min-w-0 rounded-lg border bg-muted/30 p-3"><div className="flex min-w-0 flex-col gap-3">
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0 flex-1"><p className="text-sm font-medium">Release management</p><p className="text-xs text-muted-foreground">{data ? `Latest release: ${data.latest}. Install latest or pin an exact version.` : "Loading release catalog…"}</p>
    {Boolean(error) && <p role="alert" className="text-xs text-destructive">Unable to refresh releases.{data ? " Showing cached releases." : " Check network access to GitHub."}</p>}</div>
    <Button size="sm" variant="outline" disabled={refreshing} onClick={refresh}>Refresh releases</Button></div>
    <div className="grid min-w-0 gap-2 lg:grid-cols-2"><Button disabled={blocked || refreshing || !data} onClick={() => install("latest")}>{data ? `Install latest (${data.latest})` : "Loading releases…"}</Button>
    <Field><FieldLabel htmlFor="cliproxy-release" className="sr-only">Exact release</FieldLabel><div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"><Select disabled={blocked || refreshing || !data} value={selected} onValueChange={value => select(value ?? "")}><SelectTrigger id="cliproxy-release" className="w-full min-w-0"><SelectValue placeholder="Pick exact release" /></SelectTrigger><SelectContent>{data?.versions.map(release => <SelectItem key={release.version} value={release.version}>{release.version}</SelectItem>)}</SelectContent></Select><Button variant="outline" disabled={blocked || refreshing || !data?.versions.some(release => release.version === selected)} onClick={() => install(selected)}>Install selected version</Button></div></Field></div>
  </div></div>
}

function ServiceDetails({ service }: { service: CliproxyInstanceStatus }) {
  return <>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Detail label="Installed version" value={service.version ?? (service.mode === "external" ? "Managed externally" : "Not installed")} mono />
      <Detail label="Selected release" value={service.pinnedVersion ? `${service.pinnedVersion} (pinned)` : "Latest"} />
      <Detail label="Active requests" value={String(service.activeRequests)} mono />
      <Detail label="Recovery attempts" value={String(service.restartAttempts)} mono />
    </div>
    {service.lastError && <p role="alert" className="break-words text-sm text-destructive">{service.lastError}</p>}
    {service.conflict && <p role="alert" className="text-sm text-destructive">The listener is occupied by another process. Lifecycle actions are disabled to protect it.</p>}
    {service.mode === "external" && <p className="text-sm text-muted-foreground">Process and release changes are controlled by your external deployment. Global credentials, OAuth, logs, and settings remain available here.</p>}
  </>
}

function ServiceControls({ service, blocked, choose }: { service: CliproxyInstanceStatus; blocked: boolean; choose: (action: Action) => void }) {
  return <div className="flex flex-wrap gap-2 sm:justify-end">
    {!service.processRunning && <Button disabled={blocked || !service.installed} onClick={() => choose({ action: "start", title: "Start CLIProxyAPI?" })}>Start</Button>}
    <Button variant="outline" disabled={blocked || !service.installed} onClick={() => choose({ action: "restart", title: "Restart CLIProxyAPI?" })}>Restart</Button>
    <Button variant="destructive" disabled={blocked || !service.processRunning && !service.desiredRunning} onClick={() => choose({ action: "stop", title: "Stop CLIProxyAPI?" })}>Stop</Button>
  </div>
}

function ConnectionDetails({ service }: { service?: CliproxyInstanceStatus }) {
  return <Card><CardHeader><CardTitle>Connection details</CardTitle><CardDescription>Use the dashboard&apos;s same-origin API URL with a workspace gateway key; requests are forwarded by RawRoute.</CardDescription></CardHeader><CardContent><div className="grid min-w-0 gap-3 lg:grid-cols-3">
      <Detail label="Client base URL" value={`${window.location.origin}/v1`} mono wrap copyable />
      <Detail label="Upstream management" value={service?.mode === "managed" ? "Managed by RawRoute" : "External deployment"} />
      <Detail label="Health" value={service?.healthy ? "Healthy" : service?.processRunning ? "Not healthy" : "Not running"} />
    </div></CardContent></Card>
}
