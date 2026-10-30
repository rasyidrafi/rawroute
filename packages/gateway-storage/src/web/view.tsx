import { useId, useState, type FormEvent, type ReactNode } from "react"
import { Link } from "react-router"
import useSWR from "swr"
import { ArrowRightIcon, CheckCircle2Icon, CircleAlertIcon, CopyIcon, DatabaseIcon, HardDriveIcon, KeyRoundIcon, PlugIcon, RefreshCwIcon } from "lucide-react"
import { useDashboardApi } from "@rawroute/platform/web/api-context"
import { useDashboardClipboard } from "@rawroute/platform/web/use-dashboard-clipboard"
import { Alert, AlertDescription, AlertTitle } from "@rawroute/ui/alert"
import { Badge } from "@rawroute/ui/badge"
import { Button } from "@rawroute/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@rawroute/ui/card"
import { Checkbox } from "@rawroute/ui/checkbox"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@rawroute/ui/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@rawroute/ui/field"
import { Input } from "@rawroute/ui/input"
import { ConfirmAction } from "@rawroute/ui/resource-feedback"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@rawroute/ui/select"
import { Skeleton } from "@rawroute/ui/skeleton"
import { Textarea } from "@rawroute/ui/textarea"
import { DashboardPage } from "@rawroute/ui/page-layout"
import { storageActions, type CapabilityStatus, type StorageAction, type StorageClientKey, type StorageConnection, type StorageDashboard, type StorageMultipart } from "../contracts"
import { storagePagePaths } from "../contracts/pages"

type Send = (input: Record<string, unknown>, successPrefix?: string) => Promise<void>
type StoragePage = "overview" | "connections" | "buckets" | "keys"
type Feedback = { message: string; kind: "success" | "error" }

const pageDetails: Record<StoragePage, { title: string; description: string }> = {
  overview: { title: "Overview", description: "Workspace storage access, client keys, and recovery." },
  connections: { title: "Connections", description: "Manage the S3-compatible services that store your workspace objects." },
  buckets: { title: "Buckets", description: "Make existing upstream buckets available under workspace-specific names." },
  keys: { title: "Client keys", description: "Issue and manage credentials with access limited to selected buckets and actions." },
}

function TextField({ name, label, type = "text", value = "", required = true }: { name: string; label: string; type?: string; value?: string; required?: boolean }) {
  const id = useId()
  return <Field><FieldLabel htmlFor={id}>{label}</FieldLabel><Input id={id} name={name} type={type} defaultValue={value} required={required} autoComplete="off" /></Field>
}

function Choice({ name, value, label, checked = false }: { name: string; value: string; label: string; checked?: boolean }) {
  const id = useId()
  return <Field orientation="horizontal"><Checkbox id={id} name={name} value={value} defaultChecked={checked} /><FieldLabel htmlFor={id}>{label}</FieldLabel></Field>
}

function Form({ children, label, busy, disabled, submit, validate, onInvalid }: { children: ReactNode; label: string; busy: boolean; disabled?: boolean; submit: (data: FormData) => Promise<void>; validate?: (data: FormData) => string | undefined; onInvalid?: (message: string) => void }) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const issue = validate?.(data)
    if (issue) { onInvalid?.(issue); return }
    void submit(data).then(() => form.reset()).catch(() => undefined)
  }
  return <form onSubmit={onSubmit}><FieldGroup>{children}<Button type="submit" disabled={busy || disabled}>{busy ? "Working…" : label}</Button></FieldGroup></form>
}

const text = (data: FormData, name: string) => String(data.get(name) || "")

function EmptyState({ title, description }: { title: string; description: string }) {
  return <Empty><EmptyHeader><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader></Empty>
}

function ConnectionForm({ connection, busy, send }: { connection?: StorageConnection; busy: boolean; send: Send }) {
  return <Form label={connection ? "Save connection and clear checks" : "Add connection"} busy={busy} submit={data => send({ action: "save-connection", id: connection?.id, name: text(data, "name"), endpoint: text(data, "endpoint"), region: text(data, "region"), accessKeyId: text(data, "accessKeyId"), secretAccessKey: text(data, "secretAccessKey") })}>
    <TextField name="name" label="Connection name" value={connection?.name} />
    <TextField name="endpoint" label="Upstream S3 endpoint" type="url" value={connection?.endpoint} />
    <TextField name="region" label="Upstream region" value={connection?.region || "us-east-1"} />
    <TextField name="accessKeyId" label="Upstream access key ID" />
    <TextField name="secretAccessKey" label="Upstream secret access key" type="password" />
  </Form>
}

const actionLabel = (action: StorageAction) => action
const statusLabel = (status: CapabilityStatus | undefined) => status || "Not checked"
const statusVariant = (status: CapabilityStatus | undefined): "default" | "secondary" | "destructive" | "outline" => status === "supported" ? "default" : status === "failed" ? "destructive" : status === "unsupported" ? "secondary" : "outline"

function ConnectionProbeResults({ connection }: { connection: StorageConnection }) {
  const probedActions = (["HeadBucket", "GetBucketLocation", "ListObjectsV2"] as const).filter(action => {
    const evidence = connection.capabilities[action]
    return evidence?.source === "probe" && evidence.connectionRevision === connection.revision
  })
  if (!probedActions.length) return null
  return <div className="rounded-lg border bg-muted/20 p-3">
    <p className="text-sm font-medium">Latest probe evidence recorded for this connection</p>
    <ul className="mt-2 flex flex-wrap gap-2" aria-label="Latest probe results">
      {probedActions.map(action => <li key={action}><Badge variant={statusVariant(connection.capabilities[action]?.status)}>{actionLabel(action)}: {statusLabel(connection.capabilities[action]?.status)}</Badge></li>)}
    </ul>
  </div>
}

function Connections({ data, busy, send }: { data: StorageDashboard; busy: boolean; send: Send }) {
  return <>
    <Card><CardHeader><CardTitle>Add S3 connection</CardTitle><CardDescription>Credentials are encrypted at rest. Endpoints use path-style addressing. Private origins require deployment approval.</CardDescription></CardHeader><CardContent><ConnectionForm busy={busy} send={send} /></CardContent></Card>
    {!data.connections.length && <EmptyState title="No connections yet" description="Add an upstream S3-compatible service before attaching one of its existing buckets." />}
    {data.connections.map(connection => <Card key={connection.id}>
      <CardHeader><CardTitle>{connection.name || "S3 connection"}</CardTitle><CardDescription>{connection.endpoint} · region {connection.region}</CardDescription></CardHeader>
      <CardContent className="flex flex-col" spacing="flow">
        <ConnectionProbeResults connection={connection} />
        <Form key={`${connection.revision}:${JSON.stringify(connection.capabilities)}:${JSON.stringify(connection.options)}`} busy={busy} label="Save capability checks" submit={form => {
          const selected = new Set(form.getAll("actions"))
          return send({ action: "capabilities", id: connection.id, revision: connection.revision, statuses: Object.fromEntries(storageActions.map(action => [action, selected.has(action) ? "supported" : "unknown"])), ranges: form.has("ranges") ? "supported" : "unknown", exactKeys: form.has("exactKeys") ? "supported" : "unknown" })
        }}>
          <FieldSet><FieldLegend>Verified operations</FieldLegend><FieldDescription>Only mark operations you have tested. Multipart access requires all five multipart operations. Verify raw key handling before enabling dot segments, repeated slashes, or literal percent escapes.</FieldDescription>
            {storageActions.map(action => <Choice key={action} name="actions" value={action} label={`${action} — ${connection.capabilities[action]?.status || "unknown"} (${connection.capabilities[action]?.source || "no evidence"})`} checked={connection.capabilities[action]?.status === "supported"} />)}
            <Choice name="ranges" value="supported" label={`Single-range downloads — ${connection.options?.ranges?.status || "unknown"}`} checked={connection.options?.ranges?.status === "supported"} />
            <Choice name="exactKeys" value="supported" label={`Exact object-key preservation — ${connection.options?.exactKeys?.status || "unknown"}`} checked={connection.options?.exactKeys?.status === "supported"} />
          </FieldSet>
        </Form>
        <details><summary>Edit connection and replace credentials</summary><div className="mt-4"><p className="mb-3 text-sm text-muted-foreground">Saving new credentials clears existing capability checks. Recheck the operations you rely on.</p><ConnectionForm connection={connection} busy={busy} send={send} /></div></details>
      </CardContent>
      <CardFooter><ConfirmAction buttonLabel="Delete connection" title={`Delete ${connection.name || "this connection"}?`} description="Only unattached connections can be deleted. Any attached buckets must be detached first." pending={busy} disabled={busy || data.buckets.some(bucket => bucket.connectionId === connection.id)} onConfirm={async () => { try { await send({ action: "delete-connection", id: connection.id }); return true } catch { return false } }} /></CardFooter>
    </Card>)}
  </>
}

function Buckets({ data, busy, send }: { data: StorageDashboard; busy: boolean; send: Send }) {
  const connectionFieldId = useId()
  const activeConnections = data.connections
  return <>
    <Card><CardHeader><CardTitle>Attach an existing bucket</CardTitle><CardDescription>A globally unique name is used by gateway clients. It maps to an existing upstream bucket; RawRoute does not create or delete remote buckets.</CardDescription></CardHeader><CardContent>
      <Form busy={busy} disabled={!activeConnections.length} label="Attach bucket" submit={form => send({ action: "attach-bucket", connectionId: text(form, "connectionId"), name: text(form, "name"), upstreamBucket: text(form, "upstreamBucket") })}>
        <Field><FieldLabel htmlFor={connectionFieldId}>Connection</FieldLabel><Select name="connectionId" required items={activeConnections.map(connection => ({ value: connection.id, label: connection.name || "S3 connection" }))}><SelectTrigger id={connectionFieldId}><SelectValue placeholder="Select a connection" /></SelectTrigger><SelectContent><SelectGroup>{activeConnections.map(connection => <SelectItem key={connection.id} value={connection.id}>{connection.name || "S3 connection"}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
        <TextField name="name" label="Gateway bucket name" />
        <TextField name="upstreamBucket" label="Existing upstream bucket name" />
      </Form>
      {!activeConnections.length && <p className="mt-4 text-sm text-muted-foreground">Add a connection before attaching a bucket.</p>}
    </CardContent></Card>
    {!data.buckets.length && <EmptyState title="No attached buckets" description="Attach an existing upstream bucket to make it available through a logical gateway name." />}
    {data.buckets.map(bucket => {
      const connection = data.connections.find(item => item.id === bucket.connectionId)
      return <Card key={bucket.id}>
        <CardHeader><div className="flex flex-wrap items-center gap-2"><CardTitle>{bucket.name}</CardTitle><Badge variant={bucket.state === "active" ? "default" : "secondary"}>{bucket.state === "active" ? "Active" : "Detaching"}</Badge></div><CardDescription>Existing upstream bucket: {bucket.upstreamBucket}{connection ? ` · connection: ${connection.name || "S3 connection"}` : ""}</CardDescription></CardHeader>
        <CardFooter><div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy || bucket.state !== "active"} onClick={() => { void send({ action: "probe-bucket", id: bucket.id }, `Read-only checks for ${bucket.name}`).catch(() => undefined) }}><RefreshCwIcon />Check connection</Button>
          <ConfirmAction buttonLabel={bucket.state === "active" ? "Detach bucket" : "Retry detach"} title={`${bucket.state === "active" ? "Detach" : "Retry detaching"} ${bucket.name}?`} description="This removes the gateway mapping but leaves remote objects untouched. Pending multipart uploads must be cleaned up first." pending={busy} disabled={busy} onConfirm={async () => { try { await send({ action: "detach-bucket", id: bucket.id }); return true } catch { return false } }} />
        </div></CardFooter>
      </Card>
    })}
  </>
}

function KeyPolicy({ data, clientKey, busy, send }: { data: StorageDashboard; clientKey: StorageClientKey; busy: boolean; send: Send }) {
  const buckets = new Set(clientKey.policy.bucketIds)
  const actions = new Set(clientKey.policy.actions)
  const activeBuckets = data.buckets.filter(bucket => bucket.state === "active")
  return <Form busy={busy || Boolean(clientKey.revokedAt)} label="Save client policy" submit={form => send({ action: "update-key-policy", id: clientKey.id, bucketIds: form.getAll("bucketIds"), actions: form.getAll("actions") })}>
    <FieldSet><FieldLegend>Allowed buckets</FieldLegend>{activeBuckets.length ? activeBuckets.map(bucket => <Choice key={bucket.id} name="bucketIds" value={bucket.id} label={bucket.name} checked={buckets.has(bucket.id)} />) : <FieldDescription>No active buckets are available.</FieldDescription>}</FieldSet>
    <FieldSet><FieldLegend>Allowed actions</FieldLegend>{storageActions.map(action => <Choice key={action} name="actions" value={action} label={action} checked={actions.has(action)} />)}</FieldSet>
  </Form>
}

function Keys({ data, busy, send, onInvalid }: { data: StorageDashboard; busy: boolean; send: Send; onInvalid: (message: string) => void }) {
  const activeBuckets = data.buckets.filter(bucket => bucket.state === "active")
  return <>
    <Card><CardHeader><CardTitle>Create a client key</CardTitle><CardDescription>Each key belongs to this workspace. Its policy denies every unselected bucket or action, and upstream credentials are never shared with clients.</CardDescription></CardHeader><CardContent>
      <Form busy={busy} disabled={!activeBuckets.length} label="Create key" validate={form => !form.getAll("bucketIds").length ? "Select at least one bucket." : !form.getAll("actions").length ? "Select at least one allowed action." : undefined} onInvalid={onInvalid} submit={form => send({ action: "create-key", name: text(form, "name"), bucketIds: form.getAll("bucketIds"), actions: form.getAll("actions") })}>
        <TextField name="name" label="Client key name" />
        <FieldSet><FieldLegend>Allowed buckets</FieldLegend>{activeBuckets.length ? activeBuckets.map(bucket => <Choice key={bucket.id} name="bucketIds" value={bucket.id} label={bucket.name} />) : <FieldDescription>Attach a bucket before creating a client key.</FieldDescription>}</FieldSet>
        <FieldSet><FieldLegend>Allowed actions</FieldLegend>{storageActions.map(action => <Choice key={action} name="actions" value={action} label={action} />)}</FieldSet>
      </Form>
    </CardContent></Card>
    {!data.keys.length && <EmptyState title="No client keys" description="Create a bucket-scoped key after attaching a bucket. Gateway clients never use upstream credentials." />}
    {data.keys.map(key => {
      const allowedBuckets = key.policy.bucketIds.map(id => data.buckets.find(bucket => bucket.id === id)?.name).filter((name): name is string => Boolean(name))
      return <Card key={key.id}>
        <CardHeader><div className="flex flex-wrap items-center gap-2"><CardTitle>{key.name || "Client key"}</CardTitle><Badge variant={key.revokedAt ? "secondary" : "default"}>{key.revokedAt ? "Revoked" : "Active"}</Badge></div><CardDescription><span className="font-mono">{key.accessKeyId}</span> · {allowedBuckets.length} {allowedBuckets.length === 1 ? "bucket" : "buckets"}</CardDescription></CardHeader>
        <CardContent className="flex flex-col" spacing="flow">
          <div><p className="text-sm font-medium">Access</p><p className="mt-1 text-sm text-muted-foreground">{allowedBuckets.length ? allowedBuckets.join(", ") : "No active buckets"}</p><p className="mt-1 text-sm text-muted-foreground">{key.policy.actions.length ? key.policy.actions.join(", ") : "No actions"}</p></div>
          <details><summary>Update bucket and action access</summary><div className="mt-4"><KeyPolicy data={data} clientKey={key} busy={busy} send={send} /></div></details>
        </CardContent>
        <CardFooter><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || Boolean(key.revokedAt)} onClick={() => { void send({ action: "reveal-key", id: key.id }).catch(() => undefined) }}>Reveal credentials</Button>
          <ConfirmAction buttonLabel="Revoke key" title={`Revoke ${key.name || "this key"}?`} description="Clients using this key will immediately lose access. This cannot be undone." pending={busy} disabled={busy || Boolean(key.revokedAt)} onConfirm={async () => { try { await send({ action: "revoke-key", id: key.id }); return true } catch { return false } }} />
        </div></CardFooter>
      </Card>
    })}
  </>
}

function MultipartRecovery({ data, busy, send, onInvalid }: { data: StorageDashboard; busy: boolean; send: Send; onInvalid: (message: string) => void }) {
  return <Card><CardHeader><CardTitle>Multipart recovery</CardTitle><CardDescription>Pending uploads are cleaned up before their mappings are removed. For an unclear initiation, inspect the upstream bucket before confirming an upload is absent.</CardDescription></CardHeader>
    <CardContent className="flex flex-col" spacing="flow">
      {!data.multiparts.length && <EmptyState title="No pending uploads" description="Uploads awaiting completion or cleanup will appear here." />}
      {data.multiparts.map(upload => <MultipartRecoveryItem key={upload.id} upload={upload} data={data} busy={busy} send={send} onInvalid={onInvalid} />)}
    </CardContent>
  </Card>
}

function MultipartRecoveryItem({ upload, data, busy, send, onInvalid }: { upload: StorageMultipart; data: StorageDashboard; busy: boolean; send: Send; onInvalid: (message: string) => void }) {
  const bucket = data.buckets.find(item => item.id === upload.bucketId)
  const connection = data.connections.find(item => item.id === upload.connectionId)
  const clientKey = data.keys.find(item => item.id === upload.keyId)
  const canConfirmAbsent = upload.state === "ambiguous" && !upload.remoteId
  const stateLabels: Record<StorageMultipart["state"], string> = { creating: "Starting", active: "In progress", completing: "Finishing", aborting: "Cleaning up", ambiguous: "Needs review" }
  return <Card size="sm">
    <CardHeader><div className="flex flex-wrap items-center gap-2"><CardTitle>{bucket?.name || "Detached bucket"} · {stateLabels[upload.state]}</CardTitle><Badge variant={upload.state === "ambiguous" ? "destructive" : "outline"}>{stateLabels[upload.state]}</Badge></div><CardDescription>{new Date(upload.createdAt).toLocaleString()} · {connection?.name || "Connection unavailable"} · client key: {clientKey?.name || "Key unavailable"}</CardDescription></CardHeader>
    <CardContent className="flex flex-col" spacing="compact-flow">
      <div><p className="text-xs font-medium text-muted-foreground">Upstream bucket</p><p className="mt-1 break-all font-mono text-sm">{bucket?.upstreamBucket || "Unavailable"}</p></div>
      <div><p className="text-xs font-medium text-muted-foreground">Object key</p><code className="mt-1 block break-all text-sm">{upload.key}</code></div>
      {upload.state === "ambiguous" && !upload.remoteId && <p className="text-sm text-muted-foreground">Find the provider upload ID for this object, or confirm after checking that no orphan upload remains.</p>}
      <Form busy={busy} label={upload.state === "ambiguous" ? "Resolve and clean up" : "Abort or retry cleanup"} validate={form => canConfirmAbsent && !text(form, "remoteId") && !form.has("confirmedAbsent") ? "Enter the provider upload ID or confirm that no orphan upload remains." : undefined} onInvalid={onInvalid} submit={form => send({ action: "cleanup-multipart", id: upload.id, remoteId: text(form, "remoteId") || undefined, confirmedAbsent: form.has("confirmedAbsent") })}>
        {canConfirmAbsent && <><TextField name="remoteId" label="Provider upload ID" required={false} /><Choice name="confirmedAbsent" value="yes" label="I checked upstream and confirm no orphan upload remains" /></>}
      </Form>
    </CardContent>
  </Card>
}

function Overview({ data, busy, send, onInvalid }: { data: StorageDashboard; busy: boolean; send: Send; onInvalid: (message: string) => void }) {
  const activeKeys = data.keys.filter(key => !key.revokedAt).length
  const shortcuts = [
    { href: storagePagePaths.storageConnections, label: "Connections", description: "Configure upstream services.", icon: PlugIcon },
    { href: storagePagePaths.storageBuckets, label: "Buckets", description: "Attach existing buckets.", icon: DatabaseIcon },
    { href: storagePagePaths.storageKeys, label: "Client keys", description: "Control client access.", icon: KeyRoundIcon },
  ]
  return <>
    <div className="grid gap-3 sm:grid-cols-3">
      {[{ label: "Connections", value: data.connections.length }, { label: "Attached buckets", value: data.buckets.length }, { label: "Active client keys", value: activeKeys }].map(item => <Card key={item.label}><CardHeader><CardDescription>{item.label}</CardDescription><CardTitle variant="metric">{item.value}</CardTitle></CardHeader></Card>)}
    </div>
    <Card><CardHeader><CardTitle>Connect an S3 client</CardTitle><CardDescription>Clients use the Storage S3 endpoint configured for this deployment, separate from the dashboard address.</CardDescription></CardHeader><CardContent className="flex flex-col" spacing="compact-flow"><p className="text-sm text-muted-foreground">Sign requests for region <code className="rounded bg-muted px-1 py-0.5">us-east-1</code>. Use path-style bucket addressing. Unsupported S3 features are rejected rather than silently ignored.</p><p className="text-sm text-muted-foreground">Start by adding a connection, attach an existing bucket, then issue a client key with only the access it needs.</p></CardContent></Card>
    <Card><CardHeader><CardTitle>Manage storage</CardTitle><CardDescription>Each step has its own controls and workspace-scoped access.</CardDescription></CardHeader><CardContent spacing="compact-flow" className="grid sm:grid-cols-3">{shortcuts.map(item => <Link key={item.href} to={item.href} className="rounded-lg border bg-muted/20 p-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><div className="flex items-center gap-2 font-medium"><item.icon className="size-4" />{item.label}<ArrowRightIcon className="ml-auto size-4" /></div><p className="mt-1 text-sm text-muted-foreground">{item.description}</p></Link>)}</CardContent></Card>
    <MultipartRecovery data={data} busy={busy} send={send} onInvalid={onInvalid} />
  </>
}

function Credentials({ value, onHide }: { value: { accessKeyId: string; secretAccessKey: string }; onHide: () => void }) {
  const copy = useDashboardClipboard()
  const serialized = JSON.stringify(value, null, 2)
  return <Card><CardHeader><CardTitle>Client credentials</CardTitle><CardDescription>Copy and store these securely. They are not saved in browser storage. Revealing a key is audited.</CardDescription></CardHeader><CardContent><Textarea aria-label="Client credentials" readOnly value={serialized} rows={5} /></CardContent><CardFooter><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void copy(serialized, "Credentials copied")}><CopyIcon />Copy credentials</Button><Button variant="outline" onClick={onHide}>Hide credentials</Button></div></CardFooter></Card>
}

function successMessage(action: unknown, input: Record<string, unknown>, value: unknown, successPrefix?: string) {
  switch (action) {
    case "save-connection": return input.id ? "Connection updated. Capability checks were cleared." : "Connection added."
    case "capabilities": return "Capability checks saved."
    case "attach-bucket": return "Bucket attached."
    case "create-key": return "Client key created. Copy and securely store its credentials."
    case "reveal-key": return "Credentials revealed. This access was recorded."
    case "revoke-key": return "Key revoked. Existing clients can no longer use it."
    case "update-key-policy": return "Client access updated."
    case "detach-bucket": return "Bucket detached. Remote objects were left untouched."
    case "delete-connection": return "Connection deleted."
    case "cleanup-multipart": return "Multipart upload cleanup completed."
    case "probe-bucket": {
      const statuses = value as Partial<Record<"HeadBucket" | "GetBucketLocation" | "ListObjectsV2", CapabilityStatus>> | undefined
      return `${successPrefix || "Read-only checks"} complete: ${(["HeadBucket", "GetBucketLocation", "ListObjectsV2"] as const).map(item => `${item} ${statuses?.[item] || "not checked"}`).join(" · ")}.`
    }
    default: return "Storage settings saved."
  }
}

function credentialFrom(action: unknown, value: unknown) {
  if (action !== "create-key" && action !== "reveal-key") return undefined
  const result = value as { key?: { accessKeyId?: string }; accessKeyId?: string; secretAccessKey?: string } | undefined
  const accessKeyId = action === "create-key" ? result?.key?.accessKeyId : result?.accessKeyId
  return accessKeyId && result?.secretAccessKey ? { accessKeyId, secretAccessKey: result.secretAccessKey } : undefined
}

function createStorageSender({ api, mutate, setBusy, setFeedback, setCredential }: {
  api: ReturnType<typeof useDashboardApi>
  mutate: () => Promise<unknown>
  setBusy: (value: boolean) => void
  setFeedback: (value: Feedback | undefined) => void
  setCredential: (value: { accessKeyId: string; secretAccessKey: string } | undefined) => void
}): Send {
  return async (input, successPrefix) => {
    setBusy(true)
    setFeedback(undefined)
    setCredential(undefined)
    try {
      const result = await api.apiPost<{ value?: unknown }>("/api/admin/storage", input)
      const revealed = credentialFrom(input.action, result.value)
      if (revealed) setCredential(revealed)
      const message = successMessage(input.action, input, result.value, successPrefix)
      setFeedback({ kind: "success", message })
      try { await mutate() } catch { setFeedback({ kind: "error", message: `${message} The list could not refresh; try Refresh.` }) }
    } catch (operationError) {
      try { await mutate() } catch { /* Keep the original operation error visible. */ }
      setFeedback({ kind: "error", message: operationError instanceof Error ? operationError.message : "Storage operation failed." })
      throw operationError
    } finally { setBusy(false) }
  }
}

function StoragePageBody({ page, busy, isLoading, data, error, feedback, credential, send, onRefresh, onInvalid, onHide }: {
  page: StoragePage
  busy: boolean
  isLoading: boolean
  data?: StorageDashboard
  error?: Error
  feedback?: Feedback
  credential?: { accessKeyId: string; secretAccessKey: string }
  send: Send
  onRefresh: () => void
  onInvalid: (message: string) => void
  onHide: () => void
}) {
  const details = pageDetails[page]
  const content = data?.enabled ? {
    overview: <Overview data={data} busy={busy} send={send} onInvalid={onInvalid} />,
    connections: <Connections data={data} busy={busy} send={send} />,
    buckets: <Buckets data={data} busy={busy} send={send} />,
    keys: <Keys data={data} busy={busy} send={send} onInvalid={onInvalid} />,
  }[page] : null
  return <DashboardPage spacing="normal" width="narrow">
    <Card><CardHeader><CardTitle>{details.title}</CardTitle><CardDescription>{details.description}</CardDescription></CardHeader><CardFooter><Button variant="outline" disabled={busy || isLoading} onClick={onRefresh}><RefreshCwIcon />Refresh</Button></CardFooter></Card>
    {feedback?.kind === "error" && <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>Storage needs attention</AlertTitle><AlertDescription>{feedback.message}</AlertDescription></Alert>}
    {feedback?.kind === "success" && <div className="rounded-lg border bg-muted/20 p-3 text-sm" role="status"><span className="inline-flex items-center gap-2"><CheckCircle2Icon className="size-4" />{feedback.message}</span></div>}
    {error && !feedback && <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>Storage unavailable</AlertTitle><AlertDescription>Storage configuration could not be loaded. Check the deployment configuration and retry.</AlertDescription></Alert>}
    {isLoading && <Skeleton className="h-48 w-full" />}
    {data && !data.enabled && <Alert><HardDriveIcon /><AlertTitle>Storage is not enabled</AlertTitle><AlertDescription>Enable Storage with the optional storage deployment or set STORAGE_ENABLED=true. Persistent database preparation and encryption-key creation are automatic.</AlertDescription></Alert>}
    {content}
    {credential && <Credentials value={credential} onHide={onHide} />}
  </DashboardPage>
}

export function StorageView({ page }: { page: StoragePage }) {
  const api = useDashboardApi()
  return <WorkspaceStorage key={`${api.workspaceId}:${page}`} page={page} />
}

function WorkspaceStorage({ page }: { page: StoragePage }) {
  const api = useDashboardApi()
  const { data, error, isLoading, mutate } = useSWR<StorageDashboard>(["storage", api.workspaceId], () => api.apiFetch("/api/admin/storage"))
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>()
  const [credential, setCredential] = useState<{ accessKeyId: string; secretAccessKey: string }>()
  const setInvalid = (message: string) => setFeedback({ kind: "error", message })
  const send = createStorageSender({ api, mutate, setBusy, setFeedback, setCredential })

  return <StoragePageBody page={page} busy={busy} isLoading={isLoading} data={data} error={error} feedback={feedback} credential={credential} send={send} onRefresh={() => { void mutate() }} onInvalid={setInvalid} onHide={() => setCredential(undefined)} />
}
