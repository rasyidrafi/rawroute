import { useId, useState, type FormEvent, type ReactNode } from "react"
import useSWR from "swr"
import { useDashboardApi } from "@rawroute/platform/web/api-context"
import { DashboardPage } from "@rawroute/ui/page-layout"
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@rawroute/ui/card"
import { Button } from "@rawroute/ui/button"
import { Input } from "@rawroute/ui/input"
import { Textarea } from "@rawroute/ui/textarea"
import { Checkbox } from "@rawroute/ui/checkbox"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@rawroute/ui/select"
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend, FieldDescription } from "@rawroute/ui/field"
import { Alert, AlertTitle, AlertDescription } from "@rawroute/ui/alert"
import { Badge } from "@rawroute/ui/badge"
import { Skeleton } from "@rawroute/ui/skeleton"
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@rawroute/ui/empty"
import { storageActions, type StorageDashboard, type StorageConnection, type StorageClientKey } from "../contracts"

type Send = (input: Record<string, unknown>) => Promise<void>
function TextField({ name, label, type = "text", value = "", required = true }: { name: string; label: string; type?: string; value?: string; required?: boolean }) {
  const id = useId()
  return <Field><FieldLabel htmlFor={id}>{label}</FieldLabel><Input id={id} name={name} type={type} defaultValue={value} required={required} autoComplete="off" /></Field>
}
function Choice({ name, value, label, checked = false }: { name: string; value: string; label: string; checked?: boolean }) {
  const id = useId()
  return <Field orientation="horizontal"><Checkbox id={id} name={name} value={value} defaultChecked={checked} /><FieldLabel htmlFor={id}>{label}</FieldLabel></Field>
}
function Form({ children, label, busy, submit }: { children: ReactNode; label: string; busy: boolean; submit: (data: FormData) => Promise<void> }) {
  function onSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; void submit(new FormData(form)).then(() => form.reset()).catch(() => undefined) }
  return <form onSubmit={onSubmit}><FieldGroup>{children}<Button type="submit" disabled={busy}>{busy ? "Working…" : label}</Button></FieldGroup></form>
}
const text = (data: FormData, name: string) => String(data.get(name) || "")
function EmptyState({ title, description }: { title: string; description: string }) { return <Empty><EmptyHeader><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader></Empty> }
function ConnectionForm({ connection, busy, send }: { connection?: StorageConnection; busy: boolean; send: Send }) {
  return <Form label={connection ? "Save and invalidate capability evidence" : "Add connection"} busy={busy} submit={data => send({ action: "save-connection", id: connection?.id, name: text(data, "name"), endpoint: text(data, "endpoint"), region: text(data, "region"), accessKeyId: text(data, "accessKeyId"), secretAccessKey: text(data, "secretAccessKey") })}>
    <TextField name="name" label="Connection name" value={connection?.name} /><TextField name="endpoint" label="Upstream S3 endpoint" type="url" value={connection?.endpoint} /><TextField name="region" label="Upstream region" value={connection?.region || "us-east-1"} /><TextField name="accessKeyId" label="Upstream access key ID" /><TextField name="secretAccessKey" label="Upstream secret access key" type="password" />
  </Form>
}
function Connections({ data, busy, send }: { data: StorageDashboard; busy: boolean; send: Send }) {
  return <><Card><CardHeader><CardTitle>Add S3 connection</CardTitle><CardDescription>Credentials are encrypted at rest. Endpoints use path-style addressing. Private origins require deployment approval.</CardDescription></CardHeader><CardContent><ConnectionForm busy={busy} send={send} /></CardContent></Card>
    {!data.connections.length && <EmptyState title="No connections" description="Add an upstream S3-compatible connection, then attach an existing bucket." />}
    {data.connections.map(connection => <Card key={`${connection.id}:${JSON.stringify(connection.capabilities)}:${JSON.stringify(connection.options)}`}><CardHeader><CardTitle>{connection.name}</CardTitle><CardDescription>{connection.endpoint} · {connection.region} · revision {connection.revision}</CardDescription></CardHeader><CardContent className="flex flex-col" spacing="flow">
      <Form busy={busy} label="Save administrator capability declarations" submit={form => { const selected = new Set(form.getAll("actions")); return send({ action: "capabilities", id: connection.id, revision: connection.revision, statuses: Object.fromEntries(storageActions.map(action => [action, selected.has(action) ? "supported" : "unknown"])), ranges: form.has("ranges") ? "supported" : "unknown", exactKeys: form.has("exactKeys") ? "supported" : "unknown" }) }}>
        <FieldSet><FieldLegend>Supported operations</FieldLegend><FieldDescription>Unknown operations are blocked. Declare only capabilities you have verified. Multipart requires all five multipart operations. Verify raw key handling before enabling dot segments, repeated slashes or literal percent escapes.</FieldDescription>{storageActions.map(action => <Choice key={action} name="actions" value={action} label={`${action} — ${connection.capabilities[action]?.status || "unknown"} (${connection.capabilities[action]?.source || "no evidence"})`} checked={connection.capabilities[action]?.status === "supported"} />)}<Choice name="ranges" value="supported" label="Verified single-range GET support" checked={connection.options?.ranges?.status === "supported"} /><Choice name="exactKeys" value="supported" label="Verified exact upstream key/path preservation" checked={connection.options?.exactKeys?.status === "supported"} /></FieldSet>
      </Form>
      <details><summary>Replace credentials or edit connection</summary><ConnectionForm connection={connection} busy={busy} send={send} /></details>
    </CardContent><CardFooter><Button variant="destructive" disabled={busy || data.buckets.some(bucket => bucket.connectionId === connection.id)} onClick={() => { void send({ action: "delete-connection", id: connection.id }).catch(() => undefined) }}>Delete unattached connection</Button></CardFooter></Card>)}
  </>
}
function Buckets({ data, busy, send }: { data: StorageDashboard; busy: boolean; send: Send }) {
  const connectionFieldId = useId()
  return <><Card><CardHeader><CardTitle>Attach existing bucket</CardTitle><CardDescription>A globally unique logical name maps to exactly one upstream bucket. No remote bucket is created or deleted.</CardDescription></CardHeader><CardContent><Form busy={busy} label="Attach bucket" submit={form => send({ action: "attach-bucket", connectionId: text(form, "connectionId"), name: text(form, "name"), upstreamBucket: text(form, "upstreamBucket") })}><Field><FieldLabel htmlFor={connectionFieldId}>Connection</FieldLabel><Select name="connectionId" required items={data.connections.map(connection => ({ value: connection.id, label: connection.name || connection.id }))}><SelectTrigger id={connectionFieldId}><SelectValue placeholder="Select a connection" /></SelectTrigger><SelectContent><SelectGroup>{data.connections.map(connection => <SelectItem key={connection.id} value={connection.id}>{connection.name || connection.id}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><TextField name="name" label="Globally unique logical bucket name" /><TextField name="upstreamBucket" label="Existing upstream bucket name" /></Form></CardContent></Card>
    {!data.buckets.length && <EmptyState title="No attached buckets" description="Attach an existing upstream bucket to make it available through a logical gateway name." />}
    {data.buckets.map(bucket => <Card key={bucket.id}><CardHeader><CardTitle>{bucket.name} <Badge variant="outline">{bucket.state}</Badge></CardTitle><CardDescription>Upstream bucket: {bucket.upstreamBucket}. Detaching preserves all remote objects.</CardDescription></CardHeader><CardFooter><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || bucket.state !== "active"} onClick={() => { void send({ action: "probe-bucket", id: bucket.id }).catch(() => undefined) }}>Probe read-only capabilities</Button><Button variant="destructive" disabled={busy} onClick={() => { void send({ action: "detach-bucket", id: bucket.id }).catch(() => undefined) }}>Detach and clean up multipart uploads</Button></div></CardFooter></Card>)}
  </>
}
function Keys({ data, busy, send }: { data: StorageDashboard; busy: boolean; send: Send }) {
  return <><Card><CardHeader><CardTitle>Create client key</CardTitle><CardDescription>Independent S3 credentials belong to this workspace. Policy denies every unselected bucket or action.</CardDescription></CardHeader><CardContent><Form busy={busy} label="Create key" submit={form => send({ action: "create-key", name: text(form, "name"), bucketIds: form.getAll("bucketIds"), actions: form.getAll("actions") })}><TextField name="name" label="Client key name" /><FieldSet><FieldLegend>Allowed buckets</FieldLegend>{data.buckets.filter(bucket => bucket.state === "active").map(bucket => <Choice key={bucket.id} name="bucketIds" value={bucket.id} label={bucket.name} />)}</FieldSet><FieldSet><FieldLegend>Allowed actions</FieldLegend>{storageActions.map(action => <Choice key={action} name="actions" value={action} label={action} />)}</FieldSet></Form></CardContent></Card>
    {!data.keys.length && <EmptyState title="No client keys" description="Create a bucket-scoped key after attaching a bucket. Upstream credentials are never used by gateway clients." />}
    {data.keys.map(key => <Card key={key.id}><CardHeader><CardTitle>{key.name} <Badge variant="outline">{key.revokedAt ? "Revoked" : "Active"}</Badge></CardTitle><CardDescription>{key.accessKeyId} · {key.policy.bucketIds.length} buckets · {key.policy.actions.join(", ")}</CardDescription></CardHeader><CardContent><details><summary>Update bucket/action policy</summary><KeyPolicy data={data} clientKey={key} busy={busy} send={send} /></details></CardContent><CardFooter><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || Boolean(key.revokedAt)} onClick={() => { void send({ action: "reveal-key", id: key.id }).catch(() => undefined) }}>Reveal credentials</Button><Button variant="destructive" disabled={busy || Boolean(key.revokedAt)} onClick={() => { void send({ action: "revoke-key", id: key.id }).catch(() => undefined) }}>Revoke key</Button></div></CardFooter></Card>)}
  </>
}
function KeyPolicy({ data, clientKey, busy, send }: { data: StorageDashboard; clientKey: StorageClientKey; busy: boolean; send: Send }) {
  const buckets = new Set(clientKey.policy.bucketIds)
  const actions = new Set(clientKey.policy.actions)
  return <Form busy={busy || Boolean(clientKey.revokedAt)} label="Save client policy" submit={form => send({ action: "update-key-policy", id: clientKey.id, bucketIds: form.getAll("bucketIds"), actions: form.getAll("actions") })}><FieldSet><FieldLegend>Allowed buckets</FieldLegend>{data.buckets.filter(bucket => bucket.state === "active").map(bucket => <Choice key={bucket.id} name="bucketIds" value={bucket.id} label={bucket.name} checked={buckets.has(bucket.id)} />)}</FieldSet><FieldSet><FieldLegend>Allowed actions</FieldLegend>{storageActions.map(action => <Choice key={action} name="actions" value={action} label={action} checked={actions.has(action)} />)}</FieldSet></Form>
}
type StoragePage = "overview" | "connections" | "buckets" | "keys"
export function StorageView({ page }: { page: StoragePage }) { const api = useDashboardApi(); return <WorkspaceStorage key={api.workspaceId} page={page} /> }
function WorkspaceStorage({ page }: { page: StoragePage }) {
  const api = useDashboardApi()
  const { data, error, isLoading, mutate } = useSWR<StorageDashboard>(["storage", api.workspaceId], () => api.apiFetch("/api/admin/storage"))
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string>()
  const [credential, setCredential] = useState<string>()
  const send: Send = async input => {
    setBusy(true); setFeedback(undefined); setCredential(undefined)
    try {
      const result = await api.apiPost<{ value?: unknown }>("/api/admin/storage", input)
      if (input.action === "create-key" || input.action === "reveal-key") setCredential(JSON.stringify(result.value, null, 2))
      setFeedback("Storage configuration updated."); await mutate()
    } catch (error) { setFeedback(error instanceof Error ? error.message : "Storage operation failed."); throw error } finally { setBusy(false) }
  }
  return <DashboardPage spacing="normal" width="narrow"><Card><CardHeader><CardTitle>Storage Gateway</CardTitle><CardDescription>Workspace-scoped native S3 access. Configure connections, attach buckets, declare tested capabilities, then issue client keys.</CardDescription></CardHeader><CardFooter><Button variant="outline" disabled={busy || isLoading} onClick={() => { void mutate() }}>Refresh</Button></CardFooter></Card>
    {(feedback || error) && <Alert><AlertTitle>Storage status</AlertTitle><AlertDescription>{feedback || "Storage configuration could not be loaded. Check the deployment configuration and retry."}</AlertDescription></Alert>}
    {credential && <Card><CardHeader><CardTitle>Client credentials</CardTitle><CardDescription>Copy securely. These values are not saved in browser storage. Reveals are audited.</CardDescription></CardHeader><CardContent><Textarea aria-label="Client credentials" readOnly value={credential} rows={8} /></CardContent><CardFooter><Button variant="outline" onClick={() => setCredential(undefined)}>Hide credentials</Button></CardFooter></Card>}
    {isLoading && <Skeleton className="h-48 w-full" />}
    {data && !data.enabled && <Alert><AlertTitle>Storage is optional</AlertTitle><AlertDescription>Deploy with docker-compose.storage.yml, or set STORAGE_ENABLED=true for a native deployment. Database preparation and persistent encryption key creation are automatic.</AlertDescription></Alert>}
    {data?.enabled && <>{page === "connections" && <Connections data={data} busy={busy} send={send} />}{page === "buckets" && <Buckets data={data} busy={busy} send={send} />}{page === "keys" && <Keys data={data} busy={busy} send={send} />}{page === "overview" && <><Card><CardHeader><CardTitle>Workspace storage</CardTitle><CardDescription>{data.connections.length} connections · {data.buckets.length} buckets · {data.keys.filter(key => !key.revokedAt).length} active client keys</CardDescription></CardHeader><CardContent>Use a path-style S3 client with the deployment&apos;s separate S3 endpoint and signing region. Optional checksums, tagging, versioning, copy, ACL, conditions and object locking are rejected rather than silently ignored.</CardContent></Card><Card><CardHeader><CardTitle>Multipart recovery</CardTitle><CardDescription>Remote mappings are retained until cleanup succeeds. An ambiguous initiation needs upstream inspection; never confirm absence without checking the provider.</CardDescription></CardHeader><CardContent className="flex flex-col" spacing="flow">{!data.multiparts.length && <EmptyState title="No pending multipart uploads" description="Active and recovery-owned multipart uploads will appear here." />}{data.multiparts.map(upload => <Card key={upload.id}><CardHeader><CardTitle>{upload.id}</CardTitle><CardDescription>{upload.state} · {upload.createdAt}</CardDescription></CardHeader><CardContent><Form busy={busy} label="Abort mapped upload / retry cleanup" submit={form => send({ action: "cleanup-multipart", id: upload.id, remoteId: text(form, "remoteId") || undefined, confirmedAbsent: form.has("confirmedAbsent") })}>{upload.state === "ambiguous" && !upload.remoteId && <><TextField name="remoteId" label="Provider upload ID, if found" required={false} /><Choice name="confirmedAbsent" value="yes" label="I inspected the upstream bucket and confirm no orphan upload remains" /></>}</Form></CardContent></Card>)}</CardContent></Card></>}</>}
  </DashboardPage>
}
