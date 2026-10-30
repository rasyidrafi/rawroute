import { useId, useState, type FormEvent, type ReactNode } from "react"
import { Link } from "react-router"
import useSWR from "swr"
import { ArrowRightIcon, CheckCircle2Icon, CircleAlertIcon, CopyIcon, DatabaseIcon, HardDriveIcon, KeyRoundIcon, PencilIcon, PlugIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import { useDashboardApi } from "@rawroute/platform/web/api-context"
import { useDashboardClipboard } from "@rawroute/platform/web/use-dashboard-clipboard"
import { NotFoundPage } from "@rawroute/platform/web/pages/not-found"
import { platformPagePaths } from "@rawroute/platform/contracts/dashboard"
import { Alert, AlertDescription, AlertTitle } from "@rawroute/ui/alert"
import { Badge } from "@rawroute/ui/badge"
import { Button } from "@rawroute/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { Checkbox } from "@rawroute/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@rawroute/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@rawroute/ui/field"
import { Input } from "@rawroute/ui/input"
import { ConfirmAction, EmptyTableRow, FormSubmitButton, LoadError } from "@rawroute/ui/resource-feedback"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@rawroute/ui/select"
import { Table, TableBody, TableCell, TableColumns, TableRow } from "@rawroute/ui/table"
import { Textarea } from "@rawroute/ui/textarea"
import { DashboardPage } from "@rawroute/ui/page-layout"
import { useStorageStatus } from "./availability"
import { StorageRouteSkeleton } from "./skeletons"
import { storageActions, type CapabilityStatus, type StorageClientKey, type StorageConnection, type StorageDashboard, type StorageMultipart } from "../contracts"
import { storagePagePaths, storagePages } from "../contracts/pages"

type StoragePage = "overview" | "connections" | "buckets" | "keys"
type Feedback = { message: string; kind: "success" | "error" }
type Credential = { accessKeyId: string; secretAccessKey: string }
type Send = (input: Record<string, unknown>, successPrefix?: string, errorSurface?: "page" | "dialog") => Promise<unknown>
type StoragePageId = keyof typeof storagePages
const pageId = (page: StoragePage): StoragePageId => `storage${page[0]!.toUpperCase()}${page.slice(1)}` as StoragePageId

const pageDetails: Record<StoragePage, { title: string; description: string }> = {
  overview: { title: "Storage Gateway", description: "Workspace storage access, client keys, and recovery." },
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

function DialogForm({ children, label, pending, disabled, validate, onSubmit }: {
  children: ReactNode
  label: string
  pending: boolean
  disabled?: boolean
  validate?: (data: FormData) => string | undefined
  onSubmit: (data: FormData) => Promise<boolean>
}) {
  const [error, setError] = useState<string>()
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const issue = validate?.(data)
    setError(undefined)
    if (issue) { setError(issue); return }
    try { await onSubmit(data) }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Storage operation failed.") }
  }
  return <form onSubmit={event => { void submit(event) }}><FieldGroup>{children}{error && <Alert variant="destructive"><CircleAlertIcon /><AlertDescription>{error}</AlertDescription></Alert>}<FormSubmitButton pending={pending} disabled={disabled} idleLabel={label} pendingLabel="Saving…" /></FieldGroup></form>
}

function statusLabel(status: CapabilityStatus | undefined) { return status || "Not checked" }
function statusVariant(status: CapabilityStatus | undefined): "default" | "secondary" | "destructive" | "outline" {
  return status === "supported" ? "default" : status === "failed" ? "destructive" : status === "unsupported" ? "secondary" : "outline"
}

function sendAsForm(send: Send, input: Record<string, unknown>) {
  return send(input, undefined, "dialog").then(() => true)
}

function ConnectionForm({ connection, busy, onSave }: { connection?: StorageConnection; busy: boolean; onSave: (data: FormData) => Promise<boolean> }) {
  return <DialogForm label={connection ? "Save connection and clear checks" : "Add connection"} pending={busy} onSubmit={onSave}>
    {connection && <p className="text-sm text-muted-foreground">Enter replacement upstream credentials. Saving clears capability checks so you can verify the new connection.</p>}
    <TextField name="name" label="Connection name" value={connection?.name} />
    <TextField name="endpoint" label="Upstream S3 endpoint" type="url" value={connection?.endpoint} />
    <TextField name="region" label="Upstream region" value={connection?.region || "us-east-1"} />
    <TextField name="accessKeyId" label="Upstream access key ID" />
    <TextField name="secretAccessKey" label="Upstream secret access key" type="password" />
  </DialogForm>
}

function ConnectionCapabilitiesForm({ connection, busy, onSave }: { connection: StorageConnection; busy: boolean; onSave: (data: FormData) => Promise<boolean> }) {
  return <DialogForm key={`${connection.revision}:${JSON.stringify(connection.capabilities)}:${JSON.stringify(connection.options)}`} label="Save capability checks" pending={busy} onSubmit={data => onSave(data)}>
    <FieldSet><FieldLegend>Verified operations</FieldLegend><FieldDescription>Only mark operations you have tested. Multipart access requires all five multipart operations. Verify raw key handling before enabling dot segments, repeated slashes, or literal percent escapes.</FieldDescription>
      {storageActions.map(action => <Choice key={action} name="actions" value={action} label={`${action} — ${connection.capabilities[action]?.status || "unknown"} (${connection.capabilities[action]?.source || "no evidence"})`} checked={connection.capabilities[action]?.status === "supported"} />)}
      <Choice name="ranges" value="supported" label={`Single-range downloads — ${connection.options?.ranges?.status || "unknown"}`} checked={connection.options?.ranges?.status === "supported"} />
      <Choice name="exactKeys" value="supported" label={`Exact object-key preservation — ${connection.options?.exactKeys?.status || "unknown"}`} checked={connection.options?.exactKeys?.status === "supported"} />
    </FieldSet>
  </DialogForm>
}

function ConnectionProbeResults({ connection }: { connection: StorageConnection }) {
  const actions = (["HeadBucket", "GetBucketLocation", "ListObjectsV2"] as const).filter(action => {
    const evidence = connection.capabilities[action]
    return evidence?.source === "probe" && evidence.connectionRevision === connection.revision
  })
  if (!actions.length) return <span className="text-sm text-muted-foreground">No recent bucket check</span>
  return <div className="flex flex-wrap gap-1" aria-label="Latest probe results">{actions.map(action => <Badge key={action} variant={statusVariant(connection.capabilities[action]?.status)}>{action}: {statusLabel(connection.capabilities[action]?.status)}</Badge>)}</div>
}

function Connections({ data, busy, send, onRefresh, clearFeedback }: { data: StorageDashboard; busy: boolean; send: Send; onRefresh: () => void; clearFeedback: () => void }) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<StorageConnection>()
  const [checking, setChecking] = useState<StorageConnection>()
  const openEdit = (connection: StorageConnection) => { clearFeedback(); setEditing(connection); setAdding(false) }
  const closeConnectionDialog = (open: boolean) => { if (!open) { setAdding(false); setEditing(undefined) } }
  const capabilitiesSave = (connection: StorageConnection) => (form: FormData) => {
    const selected = new Set(form.getAll("actions"))
    return sendAsForm(send, {
      action: "capabilities", id: connection.id, revision: connection.revision,
      statuses: Object.fromEntries(storageActions.map(action => [action, selected.has(action) ? "supported" : "unknown"])),
      ranges: form.has("ranges") ? "supported" : "unknown", exactKeys: form.has("exactKeys") ? "supported" : "unknown",
    })
  }
  const saveConnection = async (form: FormData) => {
    await sendAsForm(send, { action: "save-connection", id: editing?.id, name: String(form.get("name") || ""), endpoint: String(form.get("endpoint") || ""), region: String(form.get("region") || ""), accessKeyId: String(form.get("accessKeyId") || ""), secretAccessKey: String(form.get("secretAccessKey") || "") })
    closeConnectionDialog(false)
    return true
  }
  const saveCapabilities = async (form: FormData) => {
    await capabilitiesSave(checking!)(form)
    setChecking(undefined)
    return true
  }
  return <Card>
    <CardHeader><CardTitle>{pageDetails.connections.title}</CardTitle><CardDescription>{pageDetails.connections.description}</CardDescription><CardAction><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={onRefresh}><RefreshCwIcon />Refresh</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => { clearFeedback(); setAdding(true) }}><PlusIcon />Add connection</Button></div></CardAction></CardHeader>
    <Dialog open={adding || Boolean(editing)} onOpenChange={closeConnectionDialog}><DialogContent><DialogHeader><DialogTitle>{editing ? "Edit connection" : "Add S3 connection"}</DialogTitle><DialogDescription>Credentials are encrypted at rest. Endpoints use path-style addressing. Private origins require deployment approval.</DialogDescription></DialogHeader><ConnectionForm key={`${adding || Boolean(editing) ? "open" : "closed"}:${editing?.id || "new"}`} connection={editing} busy={busy} onSave={saveConnection} /></DialogContent></Dialog>
    <Dialog open={Boolean(checking)} onOpenChange={open => { if (!open) setChecking(undefined) }}><DialogContent><DialogHeader><DialogTitle>Capability checks for {checking?.name || "S3 connection"}</DialogTitle><DialogDescription>Keep only the operations verified for this connection.</DialogDescription></DialogHeader>{checking && <ConnectionCapabilitiesForm connection={checking} busy={busy} onSave={saveCapabilities} />}</DialogContent></Dialog>
    <CardContent><Table>
      <TableColumns columns={[{ id: "Connection", label: "Connection" }, { id: "Endpoint", label: "Endpoint" }, { id: "Capability checks", label: "Capability checks" }, { id: "actions", label: "", variant: "sticky-action" }]} />
      <TableBody>{data.connections.map(connection => {
        const supported = storageActions.filter(action => connection.capabilities[action]?.status === "supported" && connection.capabilities[action]?.connectionRevision === connection.revision).length
        const attached = data.buckets.some(bucket => bucket.connectionId === connection.id)
        return <TableRow key={connection.id}>
          <TableCell text="label"><div>{connection.name || "S3 connection"}</div><div className="text-xs font-normal text-muted-foreground">Region {connection.region}</div></TableCell>
          <TableCell className="max-w-64"><span className="block truncate" title={connection.endpoint}>{connection.endpoint}</span><div className="mt-1 text-xs text-muted-foreground">{connection.forcePathStyle ? "Path-style addressing" : "Virtual-host addressing"}</div></TableCell>
          <TableCell><div className="mb-1 text-sm">{supported} of {storageActions.length} operations supported</div><ConnectionProbeResults connection={connection} /></TableCell>
          <TableCell variant="sticky-action"><div className="flex justify-end gap-1"><Button aria-label={`Edit ${connection.name || "connection"}`} size="icon-sm" variant="ghost" disabled={busy} onClick={() => openEdit(connection)}><PencilIcon /></Button><Button aria-label={`Edit capability checks for ${connection.name || "connection"}`} size="icon-sm" variant="ghost" disabled={busy || data.multiparts.some(item => item.connectionId === connection.id)} onClick={() => { clearFeedback(); setChecking(connection) }}><CheckCircle2Icon /></Button><ConfirmAction buttonLabel="Delete" title={`Delete ${connection.name || "this connection"}?`} description="Only connections without attached buckets can be deleted." pending={busy} disabled={busy || attached} onConfirm={async () => { try { await send({ action: "delete-connection", id: connection.id }); return true } catch { return false } }}><Trash2Icon /></ConfirmAction></div></TableCell>
        </TableRow>
      })}{!data.connections.length && <EmptyTableRow title="No connections yet" description="Add an upstream S3-compatible service before attaching one of its existing buckets." icon={PlugIcon} colSpan={4} />}</TableBody>
    </Table></CardContent>
    {busy && <span className="sr-only" role="status">Saving Storage settings</span>}
  </Card>
}

function Buckets({ data, busy, send, onRefresh, clearFeedback }: { data: StorageDashboard; busy: boolean; send: Send; onRefresh: () => void; clearFeedback: () => void }) {
  const [attaching, setAttaching] = useState(false)
  const [probing, setProbing] = useState<string>()
  const activeConnections = data.connections
  const attach = async (form: FormData) => {
    await sendAsForm(send, { action: "attach-bucket", connectionId: String(form.get("connectionId") || ""), name: String(form.get("name") || ""), upstreamBucket: String(form.get("upstreamBucket") || "") })
    setAttaching(false)
    return true
  }
  return <Card>
    <CardHeader><CardTitle>{pageDetails.buckets.title}</CardTitle><CardDescription>{pageDetails.buckets.description} A gateway name maps to an existing upstream bucket; RawRoute does not create or delete remote buckets.</CardDescription><CardAction><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={onRefresh}><RefreshCwIcon />Refresh</Button><Button variant="outline" size="sm" disabled={busy || !activeConnections.length} onClick={() => { clearFeedback(); setAttaching(true) }}><PlusIcon />Attach bucket</Button></div></CardAction></CardHeader>
    <Dialog open={attaching} onOpenChange={setAttaching}><DialogContent><DialogHeader><DialogTitle>Attach an existing bucket</DialogTitle><DialogDescription>A globally unique name is used by gateway clients.</DialogDescription></DialogHeader><DialogForm key={attaching ? "open" : "closed"} label="Attach bucket" pending={busy} onSubmit={attach}>
      <Field><FieldLabel htmlFor="storage-connection">Connection</FieldLabel><Select name="connectionId" required items={activeConnections.map(connection => ({ value: connection.id, label: connection.name || "S3 connection" }))}><SelectTrigger id="storage-connection"><SelectValue placeholder="Select a connection" /></SelectTrigger><SelectContent><SelectGroup>{activeConnections.map(connection => <SelectItem key={connection.id} value={connection.id}>{connection.name || "S3 connection"}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
      <TextField name="name" label="Gateway bucket name" /><TextField name="upstreamBucket" label="Existing upstream bucket name" />
    </DialogForm></DialogContent></Dialog>
    <CardContent><Table>
      <TableColumns columns={[{ id: "Gateway bucket", label: "Gateway bucket" }, { id: "Upstream bucket", label: "Upstream bucket" }, { id: "Connection", label: "Connection" }, { id: "Status", label: "Status" }, { id: "actions", label: "", variant: "sticky-action" }]} />
      <TableBody>{data.buckets.map(bucket => {
        const connection = data.connections.find(item => item.id === bucket.connectionId)
        const detaching = bucket.state === "detaching"
        return <TableRow key={bucket.id} variant={detaching ? "disabled" : "default"}>
          <TableCell text="label">{bucket.name}</TableCell><TableCell text="mono">{bucket.upstreamBucket}</TableCell><TableCell>{connection?.name || "Connection unavailable"}</TableCell>
          <TableCell><Badge variant={detaching ? "secondary" : "default"}>{detaching ? "Detaching" : "Active"}</Badge></TableCell>
          <TableCell variant="sticky-action"><div className="flex justify-end gap-1"><Button variant="outline" size="icon-sm" aria-label={`Check connection for ${bucket.name}`} disabled={busy || detaching} onClick={() => { setProbing(bucket.id); void send({ action: "probe-bucket", id: bucket.id }, `Read-only checks for ${bucket.name}`).catch(() => undefined).finally(() => setProbing(undefined)) }}>{probing === bucket.id ? <RefreshCwIcon className="animate-spin" /> : <RefreshCwIcon />}</Button><ConfirmAction buttonLabel={detaching ? "Retry detach" : "Detach"} title={`${detaching ? "Retry detaching" : "Detach"} ${bucket.name}?`} description="This removes the gateway mapping but leaves remote objects untouched. Pending multipart uploads must be cleaned up first." pending={busy} disabled={busy} onConfirm={async () => { try { await send({ action: "detach-bucket", id: bucket.id }); return true } catch { return false } }} /></div></TableCell>
        </TableRow>
      })}{!data.buckets.length && <EmptyTableRow title="No attached buckets" description={activeConnections.length ? "Attach an existing upstream bucket to make it available through a logical gateway name." : "Add a connection before attaching a bucket."} icon={DatabaseIcon} colSpan={5} />}</TableBody>
    </Table></CardContent>
  </Card>
}

function KeyPolicyForm({ data, clientKey, busy, onSave }: { data: StorageDashboard; clientKey: StorageClientKey; busy: boolean; onSave: (form: FormData) => Promise<boolean> }) {
  const bucketIds = new Set(clientKey.policy.bucketIds)
  const actions = new Set(clientKey.policy.actions)
  const activeBuckets = data.buckets.filter(bucket => bucket.state === "active")
  return <DialogForm label="Save client policy" pending={busy || Boolean(clientKey.revokedAt)} disabled={Boolean(clientKey.revokedAt)} onSubmit={onSave}>
    <FieldSet><FieldLegend>Allowed buckets</FieldLegend>{activeBuckets.length ? activeBuckets.map(bucket => <Choice key={bucket.id} name="bucketIds" value={bucket.id} label={bucket.name} checked={bucketIds.has(bucket.id)} />) : <FieldDescription>No active buckets are available.</FieldDescription>}</FieldSet>
    <FieldSet><FieldLegend>Allowed actions</FieldLegend>{storageActions.map(action => <Choice key={action} name="actions" value={action} label={action} checked={actions.has(action)} />)}</FieldSet>
  </DialogForm>
}

function Keys({ data, busy, send, credential, setCredential, onRefresh, clearFeedback }: { data: StorageDashboard; busy: boolean; send: Send; credential?: Credential; setCredential: (value: Credential | undefined) => void; onRefresh: () => void; clearFeedback: () => void }) {
  const [creating, setCreating] = useState(false)
  const [editingPolicy, setEditingPolicy] = useState<StorageClientKey>()
  const activeBuckets = data.buckets.filter(bucket => bucket.state === "active")
  const create = async (form: FormData) => {
    await sendAsForm(send, { action: "create-key", name: String(form.get("name") || ""), bucketIds: form.getAll("bucketIds"), actions: form.getAll("actions") })
    setCreating(false)
    return true
  }
  const savePolicy = async (form: FormData) => {
    await sendAsForm(send, { action: "update-key-policy", id: editingPolicy?.id, bucketIds: form.getAll("bucketIds"), actions: form.getAll("actions") })
    setEditingPolicy(undefined)
    return true
  }
  return <>
    <Card>
      <CardHeader><CardTitle>{pageDetails.keys.title}</CardTitle><CardDescription>{pageDetails.keys.description} Each key belongs to this workspace; upstream credentials are never shared with clients.</CardDescription><CardAction><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={onRefresh}><RefreshCwIcon />Refresh</Button><Button variant="outline" size="sm" disabled={busy || !activeBuckets.length} onClick={() => { clearFeedback(); setCredential(undefined); setCreating(true) }}><PlusIcon />Create key</Button></div></CardAction></CardHeader>
      <Dialog open={creating} onOpenChange={setCreating}><DialogContent><DialogHeader><DialogTitle>Create a client key</DialogTitle><DialogDescription>Its policy denies every unselected bucket or action. Copy the new secret when it is shown; it will not be saved in browser storage.</DialogDescription></DialogHeader><DialogForm key={creating ? "open" : "closed"} label="Create key" pending={busy} validate={form => !form.getAll("bucketIds").length ? "Select at least one bucket." : !form.getAll("actions").length ? "Select at least one allowed action." : undefined} onSubmit={create}>
        <TextField name="name" label="Client key name" /><FieldSet><FieldLegend>Allowed buckets</FieldLegend>{activeBuckets.length ? activeBuckets.map(bucket => <Choice key={bucket.id} name="bucketIds" value={bucket.id} label={bucket.name} />) : <FieldDescription>Attach a bucket before creating a client key.</FieldDescription>}</FieldSet><FieldSet><FieldLegend>Allowed actions</FieldLegend>{storageActions.map(action => <Choice key={action} name="actions" value={action} label={action} />)}</FieldSet>
      </DialogForm></DialogContent></Dialog>
      <Dialog open={Boolean(editingPolicy)} onOpenChange={open => { if (!open) setEditingPolicy(undefined) }}><DialogContent><DialogHeader><DialogTitle>Update access for {editingPolicy?.name || "client key"}</DialogTitle><DialogDescription>Only selected active buckets and operations are allowed.</DialogDescription></DialogHeader>{editingPolicy && <KeyPolicyForm key={editingPolicy.id} data={data} clientKey={editingPolicy} busy={busy} onSave={savePolicy} />}</DialogContent></Dialog>
      <CardContent><Table>
        <TableColumns columns={[{ id: "Client key", label: "Client key" }, { id: "Access key ID", label: "Access key ID" }, { id: "Buckets", label: "Buckets" }, { id: "Actions", label: "Actions" }, { id: "Status", label: "Status" }, { id: "actions", label: "", variant: "sticky-action" }]} />
        <TableBody>{data.keys.map(key => {
          const allowedBuckets = key.policy.bucketIds.map(id => data.buckets.find(bucket => bucket.id === id)?.name).filter((name): name is string => Boolean(name))
          const revoked = Boolean(key.revokedAt)
          return <TableRow key={key.id} variant={revoked ? "disabled" : "default"}>
            <TableCell text="label">{key.name || "Client key"}</TableCell><TableCell text="code">{key.accessKeyId}</TableCell><TableCell className="max-w-48 whitespace-normal">{allowedBuckets.length ? allowedBuckets.join(", ") : "No active buckets"}</TableCell><TableCell text="small" className="max-w-64 whitespace-normal">{key.policy.actions.length ? key.policy.actions.join(", ") : "No actions"}</TableCell><TableCell><Badge variant={revoked ? "secondary" : "default"}>{revoked ? "Revoked" : "Active"}</Badge></TableCell>
        <TableCell variant="sticky-action"><div className="flex justify-end gap-1"><Button variant="ghost" size="icon-sm" aria-label={`Edit access for ${key.name || "client key"}`} disabled={busy || revoked} onClick={() => { clearFeedback(); setEditingPolicy(key) }}><PencilIcon /></Button><Button variant="outline" size="sm" disabled={busy || revoked} onClick={() => { void send({ action: "reveal-key", id: key.id }).catch(() => undefined) }}>Reveal</Button><ConfirmAction buttonLabel="Revoke" title={`Revoke ${key.name || "this key"}?`} description="Clients using this key will immediately lose access. This cannot be undone." pending={busy} disabled={busy || revoked} onConfirm={async () => { try { await send({ action: "revoke-key", id: key.id }); return true } catch { return false } }}><Trash2Icon /></ConfirmAction></div></TableCell>
          </TableRow>
        })}{!data.keys.length && <EmptyTableRow title="No client keys" description={activeBuckets.length ? "Create a bucket-scoped key. Gateway clients never use upstream credentials." : "Attach a bucket before creating a client key."} icon={KeyRoundIcon} colSpan={6} />}</TableBody>
      </Table></CardContent>
    </Card>
    <CredentialsDialog value={credential} onHide={() => setCredential(undefined)} />
  </>
}

function CredentialsDialog({ value, onHide }: { value?: Credential; onHide: () => void }) {
  const copy = useDashboardClipboard()
  const serialized = value ? JSON.stringify(value, null, 2) : ""
  return <Dialog open={Boolean(value)} onOpenChange={open => { if (!open) onHide() }}><DialogContent><DialogHeader><DialogTitle>Client credentials</DialogTitle><DialogDescription>Copy and store these securely. They are not saved in browser storage. Revealing a key is audited.</DialogDescription></DialogHeader><Textarea aria-label="Client credentials" readOnly value={serialized} rows={5} /><DialogFooter><Button variant="outline" onClick={() => void copy(serialized, "Credentials copied")}><CopyIcon />Copy credentials</Button><Button onClick={onHide}>Hide credentials</Button></DialogFooter></DialogContent></Dialog>
}

function MultipartRecoveryItem({ upload, data, busy, send, clearFeedback }: { upload: StorageMultipart; data: StorageDashboard; busy: boolean; send: Send; clearFeedback: () => void }) {
  const [open, setOpen] = useState(false)
  const bucket = data.buckets.find(item => item.id === upload.bucketId)
  const connection = data.connections.find(item => item.id === upload.connectionId)
  const clientKey = data.keys.find(item => item.id === upload.keyId)
  const canConfirmAbsent = upload.state === "ambiguous" && !upload.remoteId
  const stateLabels: Record<StorageMultipart["state"], string> = { creating: "Starting", active: "In progress", completing: "Finishing", aborting: "Cleaning up", ambiguous: "Needs review" }
  const resolve = async (form: FormData) => {
    await sendAsForm(send, { action: "cleanup-multipart", id: upload.id, remoteId: String(form.get("remoteId") || "") || undefined, confirmedAbsent: form.has("confirmedAbsent") })
    setOpen(false)
    return true
  }
  return <TableRow>
    <TableCell text="label">{bucket?.name || "Detached bucket"}</TableCell><TableCell className="max-w-64"><code className="block truncate" title={upload.key}>{upload.key}</code><div className="mt-1 text-xs text-muted-foreground">{new Date(upload.createdAt).toLocaleString()}</div></TableCell><TableCell>{connection?.name || "Connection unavailable"}<div className="text-xs text-muted-foreground">Client key: {clientKey?.name || "Key unavailable"}</div></TableCell><TableCell><Badge variant={upload.state === "ambiguous" ? "destructive" : "outline"}>{stateLabels[upload.state]}</Badge></TableCell>
    <TableCell variant="sticky-action"><Button size="sm" variant="outline" disabled={busy} onClick={() => { clearFeedback(); setOpen(true) }}>{upload.state === "ambiguous" ? "Review" : "Clean up"}</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>{bucket?.name || "Detached bucket"} · {stateLabels[upload.state]}</DialogTitle><DialogDescription>Upstream bucket: {bucket?.upstreamBucket || "Unavailable"}. Object key: {upload.key}</DialogDescription></DialogHeader>{canConfirmAbsent && <p className="text-sm text-muted-foreground">Find the provider upload ID for this object, or confirm after checking that no orphan upload remains.</p>}<DialogForm key={open ? "open" : "closed"} label={upload.state === "ambiguous" ? "Resolve and clean up" : "Abort or retry cleanup"} pending={busy} validate={form => canConfirmAbsent && !String(form.get("remoteId") || "").trim() && !form.has("confirmedAbsent") ? "Enter the provider upload ID or confirm that no orphan upload remains." : undefined} onSubmit={resolve}>{canConfirmAbsent && <><TextField name="remoteId" label="Provider upload ID" required={false} /><Choice name="confirmedAbsent" value="yes" label="I checked upstream and confirm no orphan upload remains" /></>}</DialogForm></DialogContent></Dialog></TableCell>
  </TableRow>
}

function MultipartRecovery({ data, busy, send, clearFeedback }: { data: StorageDashboard; busy: boolean; send: Send; clearFeedback: () => void }) {
  return <Card>
    <CardHeader><CardTitle>Multipart recovery</CardTitle><CardDescription>Pending uploads are cleaned up before their mappings are removed. For an unclear initiation, inspect the upstream bucket before confirming an upload is absent.</CardDescription></CardHeader>
    <CardContent><Table><TableColumns columns={[{ id: "Bucket", label: "Bucket" }, { id: "Object key", label: "Object key" }, { id: "Connection / key", label: "Connection / key" }, { id: "Status", label: "Status" }, { id: "actions", label: "", variant: "sticky-action" }]} /><TableBody>
      {data.multiparts.map(upload => <MultipartRecoveryItem key={upload.id} upload={upload} data={data} busy={busy} send={send} clearFeedback={clearFeedback} />)}
      {!data.multiparts.length && <EmptyTableRow title="No pending uploads" description="Uploads awaiting completion or cleanup will appear here." colSpan={5} />}
    </TableBody></Table></CardContent>
  </Card>
}

function Overview({ data, busy, isLoading, send, onRefresh, clearFeedback }: { data: StorageDashboard; busy: boolean; isLoading: boolean; send: Send; onRefresh: () => void; clearFeedback: () => void }) {
  const activeKeys = data.keys.filter(key => !key.revokedAt).length
  const shortcuts = [
    { href: storagePagePaths.storageConnections, label: "Connections", description: "Configure upstream services.", icon: PlugIcon },
    { href: storagePagePaths.storageBuckets, label: "Buckets", description: "Attach existing buckets.", icon: DatabaseIcon },
    { href: storagePagePaths.storageKeys, label: "Client keys", description: "Control client access.", icon: KeyRoundIcon },
  ]
  return <>
    <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 className="text-2xl font-semibold tracking-tight">{pageDetails.overview.title}</h2><p className="mt-1 text-sm text-muted-foreground">{pageDetails.overview.description}</p></div><Button variant="outline" size="sm" disabled={busy || isLoading} onClick={onRefresh}><RefreshCwIcon />Refresh</Button></div>
    <div className="grid gap-4 sm:grid-cols-3">{[{ label: "Connections", value: data.connections.length }, { label: "Attached buckets", value: data.buckets.length }, { label: "Active client keys", value: activeKeys }].map(item => <Card key={item.label}><CardHeader><CardDescription>{item.label}</CardDescription><CardTitle variant="metric">{item.value}</CardTitle></CardHeader></Card>)}</div>
    <Card><CardHeader><CardTitle variant="icon"><HardDriveIcon className="size-5" />Connect an S3 client</CardTitle><CardDescription>Clients use the Storage S3 endpoint configured for this deployment, separate from the dashboard address.</CardDescription></CardHeader><CardContent className="flex flex-col" spacing="compact-flow"><p className="text-sm text-muted-foreground">Sign requests for region <code className="rounded bg-muted px-1 py-0.5">us-east-1</code>. Use path-style bucket addressing. Unsupported S3 features are rejected rather than silently ignored.</p><p className="text-sm text-muted-foreground">Start by adding a connection, attach an existing bucket, then issue a client key with only the access it needs.</p></CardContent></Card>
    <Card><CardHeader><CardTitle>Manage storage</CardTitle><CardDescription>Each step has its own controls and workspace-scoped access.</CardDescription></CardHeader><CardContent spacing="compact-flow" className="grid sm:grid-cols-3">{shortcuts.map(item => <Link key={item.href} to={item.href} className="rounded-lg border bg-muted/20 p-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><div className="flex items-center gap-2 font-medium"><item.icon className="size-4" />{item.label}<ArrowRightIcon className="ml-auto size-4" /></div><p className="mt-1 text-sm text-muted-foreground">{item.description}</p></Link>)}</CardContent></Card>
    <MultipartRecovery data={data} busy={busy} send={send} clearFeedback={clearFeedback} />
  </>
}

function successMessage(action: unknown, value: unknown, successPrefix?: string) {
  switch (action) {
    case "save-connection": return "Connection saved. Capability checks were cleared."
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

function credentialFrom(action: unknown, value: unknown): Credential | undefined {
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
  setCredential: (value: Credential | undefined) => void
}): Send {
  return async (input, successPrefix, errorSurface = "page") => {
    setBusy(true)
    setFeedback(undefined)
    setCredential(undefined)
    try {
      const result = await api.apiPost<{ value?: unknown }>("/api/admin/storage", input)
      const revealed = credentialFrom(input.action, result.value)
      if (revealed) setCredential(revealed)
      const message = successMessage(input.action, result.value, successPrefix)
      setFeedback({ kind: "success", message })
      try { await mutate() } catch { setFeedback({ kind: "error", message: `${message} The list could not refresh; try Refresh.` }) }
      return result.value
    } catch (operationError) {
      try { await mutate() } catch { /* Keep the original operation error visible. */ }
      if (errorSurface !== "dialog") setFeedback({ kind: "error", message: operationError instanceof Error ? operationError.message : "Storage operation failed." })
      throw operationError
    } finally { setBusy(false) }
  }
}

function StorageContent({ page, busy, isLoading, data, error, feedback, credential, send, onRefresh, clearFeedback, setCredential }: {
  page: StoragePage
  busy: boolean
  isLoading: boolean
  data: StorageDashboard
  error?: Error
  feedback?: Feedback
  credential?: Credential
  send: Send
  onRefresh: () => void
  clearFeedback: () => void
  setCredential: (value: Credential | undefined) => void
}) {
  const content = {
    overview: <Overview data={data} busy={busy} isLoading={isLoading} send={send} onRefresh={onRefresh} clearFeedback={clearFeedback} />,
    connections: <Connections data={data} busy={busy} send={send} onRefresh={onRefresh} clearFeedback={clearFeedback} />,
    buckets: <Buckets data={data} busy={busy} send={send} onRefresh={onRefresh} clearFeedback={clearFeedback} />,
    keys: <Keys data={data} busy={busy} send={send} credential={credential} setCredential={setCredential} onRefresh={onRefresh} clearFeedback={clearFeedback} />,
  }[page]
  return <DashboardPage spacing="normal" aria-busy={busy || isLoading || undefined}>
    {feedback?.kind === "error" && <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>Storage needs attention</AlertTitle><AlertDescription>{feedback.message}</AlertDescription></Alert>}
    {feedback?.kind === "success" && <div className="rounded-lg border bg-muted/20 p-3 text-sm" role="status"><span className="inline-flex items-center gap-2"><CheckCircle2Icon className="size-4" />{feedback.message}</span></div>}
    {error && <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>Storage unavailable</AlertTitle><AlertDescription>Storage configuration could not be loaded. Check the deployment configuration and retry.</AlertDescription></Alert>}
    {content}
  </DashboardPage>
}

function WorkspaceStorage({ page }: { page: StoragePage }) {
  const api = useDashboardApi()
  const { data, error, isLoading, isValidating, mutate } = useSWR<StorageDashboard>(["storage", api.workspaceId], () => api.apiFetch("/api/admin/storage"))
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>()
  const [credential, setCredential] = useState<Credential>()
  const send = createStorageSender({ api, mutate, setBusy, setFeedback, setCredential })

  if (error && !data) return <LoadError title="Storage unavailable" error={new Error("Storage configuration could not be loaded. Retry to try again.")} retrying={isValidating} onRetry={() => { void mutate() }} />
  if (isLoading || !data) return <StorageRouteSkeleton page={pageId(page)} />
  if (!data.enabled) return <NotFoundPage defaultLanding={platformPagePaths.home} />
  return <StorageContent page={page} busy={busy} isLoading={isLoading} data={data} error={error} feedback={feedback} credential={credential} send={send} onRefresh={() => { void mutate() }} clearFeedback={() => setFeedback(undefined)} setCredential={setCredential} />
}

export function StorageView({ page }: { page: StoragePage }) {
  const api = useDashboardApi()
  const { data, error, isValidating, mutate } = useStorageStatus()
  if (error) return <LoadError title="Storage availability unavailable" error={new Error("Storage availability could not be checked. Retry to try again.")} retrying={isValidating} onRetry={() => { void mutate() }} />
  if (!data) return <StorageRouteSkeleton page={pageId(page)} />
  if (data.state !== "available") return <NotFoundPage defaultLanding={platformPagePaths.home} />
  return <WorkspaceStorage key={`${api.workspaceId}:${page}`} page={page} />
}
