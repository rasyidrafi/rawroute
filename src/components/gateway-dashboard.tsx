"use client"

import { useState, type FormEvent } from "react"
import { ArrowLeftIcon, ChevronRightIcon, CopyIcon, KeyRoundIcon, LockKeyholeIcon, PencilIcon, PlusIcon, RouteIcon, Trash2Icon } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"

import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { LoadingSpinner } from "@/components/loading-spinner"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { protocolLabels, type ApiKey, type Model, type Protocol, type Provider, type ProviderApiKey } from "@/lib/types"
import { countProviderApiKeys } from "@/lib/provider-summary"

type State = { admin: { username: string; mustChangePassword: boolean }; providers: Provider[]; providerApiKeys: ProviderApiKey[]; models: Model[]; apiKeys: ApiKey[] }
const protocols: Protocol[] = ["openai-chat", "openai-responses", "anthropic-messages"]

async function action(payload: Record<string, unknown>) {
  const response = await fetch("/api/admin/state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error?.message || "Request failed")
  return result
}

async function fetchState(url: string) {
  const response = await fetch(url, { cache: "no-store" })
  if (response.status === 401) {
    window.location.assign("/login")
    throw new Error("Unauthorized")
  }
  if (!response.ok) throw new Error("Unable to load dashboard")
  return response.json() as Promise<State>
}

export function GatewayDashboard({ view, providerId }: { view: "endpoint-key" | "providers" | "provider-detail" | "models" | "settings"; providerId?: string }) {
  const router = useRouter()
  const { data: state, error, isLoading, mutate } = useSWR("/api/admin/state", fetchState, { revalidateOnFocus: false })
  const [providerOpen, setProviderOpen] = useState(false)
  const [providerKeyOpen, setProviderKeyOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [editingProviderApiKey, setEditingProviderApiKey] = useState<ProviderApiKey | null>(null)
  const [editingModel, setEditingModel] = useState<Model | null>(null)
  const [pendingActions, setPendingActions] = useState<Set<string>>(() => new Set())
  async function run(payload: Record<string, unknown>, message: string, key = String(payload.action)) {
    setPendingActions((current) => new Set(current).add(key))
    try {
      await action(payload)
      toast.success(message)
      await mutate()
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPendingActions((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  const isPending = (key: string) => pendingActions.has(key)

  if (error) return <main className="grid min-h-[calc(100svh-var(--header-height))] place-items-center p-6 text-center"><div><p className="font-medium">Dashboard unavailable</p><p className="mt-2 text-sm text-muted-foreground">{error.message}</p><Button className="mt-4" onClick={() => void mutate()}>Try again</Button></div></main>
  if (isLoading || !state) return <DashboardContentSkeleton />

  return <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-8">
        {view === "providers" && <ProviderList
          providers={state.providers}
          providerApiKeys={state.providerApiKeys}
          models={state.models}
          isPending={isPending}
          onAdd={() => { setEditingProvider(null); setProviderOpen(true) }}
          onDeleteProviderList={(provider) => run({ action: "delete-provider", id: provider.id }, "Provider deleted", `delete-provider:${provider.id}`)}
        />}
        {view === "provider-detail" && <ProviderDetail
          provider={state.providers.find((provider) => provider.id === providerId)}
          apiKeys={state.providerApiKeys.filter((apiKey) => apiKey.providerId === providerId)}
          modelCount={state.models.filter((model) => model.providerId === providerId).length}
          isPending={isPending}
          onAddKey={() => { setEditingProviderApiKey(null); setProviderKeyOpen(true) }}
          onEditProvider={(provider) => { setEditingProvider(provider); setProviderOpen(true) }}
          onEditKey={(apiKey) => { setEditingProviderApiKey(apiKey); setProviderKeyOpen(true) }}
          onDeleteProvider={async (provider) => {
            const deleted = await run({ action: "delete-provider", id: provider.id }, "Provider deleted", `delete-provider:${provider.id}`)
            if (deleted) router.push("/dashboard/providers")
            return deleted
          }}
          onDeleteKey={(apiKey) => run({ action: "delete-provider-api-key", id: apiKey.id }, "Provider API key deleted", `delete-provider-api-key:${apiKey.id}`)}
        />}
        <Dialog open={providerOpen} onOpenChange={(open) => { setProviderOpen(open); if (!open) setEditingProvider(null) }}><DialogContent><ProviderForm key={editingProvider?.id || "new"} provider={editingProvider} onSave={async (provider) => { const saved = await run({ action: "save-provider", provider }, editingProvider ? "Provider updated" : "Provider saved", "save-provider"); if (saved) setProviderOpen(false); return saved }} /></DialogContent></Dialog>
        <Dialog open={providerKeyOpen} onOpenChange={(open) => { setProviderKeyOpen(open); if (!open) setEditingProviderApiKey(null) }}><DialogContent><ProviderApiKeyForm key={editingProviderApiKey?.id || "new"} providers={state.providers.filter((provider) => !providerId || provider.id === providerId)} apiKey={editingProviderApiKey} onSave={async (providerApiKey) => { const saved = await run({ action: "save-provider-api-key", providerApiKey }, editingProviderApiKey ? "Provider API key updated" : "Provider API key added", "save-provider-api-key"); if (saved) setProviderKeyOpen(false); return saved }} /></DialogContent></Dialog>
        {view === "models" && <Card><CardHeader><CardTitle>Models</CardTitle><CardDescription>Gateway IDs mapped to exact upstream model IDs.</CardDescription><CardAction><Button disabled={!state.providers.length} onClick={() => { setEditingModel(null); setModelOpen(true) }}><PlusIcon />Add model</Button></CardAction></CardHeader><Dialog open={modelOpen} onOpenChange={(open) => { setModelOpen(open); if (!open) setEditingModel(null) }}><DialogContent><ModelForm key={editingModel?.id || "new"} providers={state.providers} model={editingModel} onSave={async (model) => { const saved = await run({ action: "save-model", model }, editingModel ? "Model updated" : "Model saved", "save-model"); if (saved) setModelOpen(false); return saved }} /></DialogContent></Dialog><CardContent><Table><TableHeader><TableRow><TableHead>Model</TableHead><TableHead>Provider</TableHead><TableHead>Gateway ID</TableHead><TableHead>Upstream model</TableHead><TableHead>Protocol</TableHead><TableHead /></TableRow></TableHeader><TableBody>{state.models.map((model) => { const provider = state.providers.find((item) => item.id === model.providerId); const pendingKey = `delete-model:${model.id}`; return <TableRow key={model.id}><TableCell className="font-medium">{model.name}</TableCell><TableCell>{provider?.name || "Unknown provider"}</TableCell><TableCell className="font-mono text-xs font-medium">{model.id}{model.unprefixed && <Badge variant="outline" className="ml-2">no prefix</Badge>}</TableCell><TableCell>{model.upstreamModel}</TableCell><TableCell>{protocolLabels[model.protocol || provider?.protocol || "openai-chat"]}{model.protocol && <Badge variant="outline" className="ml-2">override</Badge>}</TableCell><TableCell><div className="flex justify-end gap-1"><Button aria-label={`Edit ${model.id}`} size="icon-sm" variant="ghost" onClick={() => { setEditingModel(model); setModelOpen(true) }}><PencilIcon /></Button><ConfirmAction title={`Delete ${model.id}?`} description="Requests using this gateway model ID will stop working." pending={isPending(pendingKey)} onConfirm={() => run({ action: "delete-model", id: model.id }, "Model deleted", pendingKey)}><Trash2Icon /></ConfirmAction></div></TableCell></TableRow> })}{!state.models.length && <EmptyRow label="Add a provider, then expose its first model." colSpan={6} />}</TableBody></Table></CardContent></Card>}
        {view === "settings" && <Card className="max-w-2xl"><CardHeader><CardTitle className="flex items-center gap-2"><LockKeyholeIcon className="size-5" />Admin password</CardTitle><CardDescription>Confirm your current password before choosing a new one.</CardDescription></CardHeader><CardContent><ChangePasswordForm onSave={(currentPassword, newPassword, confirmPassword) => run({ action: "update-password", currentPassword, newPassword, confirmPassword }, "Password updated", "update-password")} /></CardContent></Card>}
        {view === "endpoint-key" && <><Card><CardHeader><CardTitle className="flex items-center gap-2"><RouteIcon className="size-5" />API Endpoint</CardTitle><CardDescription>Use this base URL with the native protocol endpoint supported by each model.</CardDescription></CardHeader><CardContent><div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3"><Badge variant="secondary" className="shrink-0">Gateway</Badge><EndpointValue /><Button aria-label="Copy API endpoint" size="icon-sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}/v1`); toast.success("Endpoint copied") }}><CopyIcon /></Button></div></CardContent></Card><Card><CardHeader><CardTitle>Gateway API keys</CardTitle><CardDescription>Clients use these keys to access every proxy endpoint.</CardDescription><CardAction><Button onClick={() => setKeyOpen(true)}><PlusIcon />Create key</Button></CardAction></CardHeader><Dialog open={keyOpen} onOpenChange={setKeyOpen}><DialogContent><ApiKeyForm onSave={async (name) => { const saved = await run({ action: "create-api-key", name }, "API key created", "create-api-key"); if (saved) setKeyOpen(false); return saved }} /></DialogContent></Dialog><CardContent className="space-y-3">{state.apiKeys.map((key) => { const pendingKey = `delete-api-key:${key.id}`; return <div key={key.id} className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3"><div className="min-w-0 flex-1"><div className="text-sm font-medium">{key.name}</div><code className="block truncate text-xs text-muted-foreground">{maskApiKey(key.key)}</code></div><Button aria-label={`Copy ${key.name}`} size="icon-sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(key.key); toast.success("Copied") }}><CopyIcon /></Button><ConfirmAction title={`Delete ${key.name}?`} description="Clients using this key will immediately lose access." pending={isPending(pendingKey)} disabled={state.apiKeys.length === 1} onConfirm={() => run({ action: "delete-api-key", id: key.id }, "API key deleted", pendingKey)}><Trash2Icon /></ConfirmAction></div> })}</CardContent></Card></>}
      </div>

    <PasswordDialog open={state.admin.mustChangePassword} onSave={(password) => run({ action: "change-password", password }, "Password changed", "change-password")} />
  </main>
}

function ProviderList({ providers, providerApiKeys, models, isPending, onAdd, onDeleteProviderList }: { providers: Provider[]; providerApiKeys: ProviderApiKey[]; models: Model[]; isPending: (key: string) => boolean; onAdd: () => void; onDeleteProviderList: (provider: Provider) => Promise<boolean> }) {
  return <Card><CardHeader><CardTitle>Providers</CardTitle><CardDescription>Choose a provider to manage its connection settings and upstream API keys.</CardDescription><CardAction><Button onClick={onAdd}><PlusIcon />Add provider</Button></CardAction></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Provider</TableHead><TableHead>Prefix</TableHead><TableHead>Protocol</TableHead><TableHead>Origin</TableHead><TableHead>API keys</TableHead><TableHead /></TableRow></TableHeader><TableBody>{providers.map((provider) => {
    const counts = countProviderApiKeys(provider.id, providerApiKeys)
    const modelCount = models.filter((model) => model.providerId === provider.id).length
    return <TableRow key={provider.id}><TableCell><Link href={`/dashboard/providers/${provider.id}`} className="font-medium hover:underline">{provider.name}</Link></TableCell><TableCell><Badge variant="secondary">{provider.prefix}/</Badge></TableCell><TableCell>{protocolLabels[provider.protocol]}</TableCell><TableCell className="max-w-64 truncate font-mono text-xs">{provider.baseUrl}</TableCell><TableCell><div className="flex items-center gap-2"><span className="font-medium tabular-nums">{counts.configured}</span><span className="text-xs text-muted-foreground">configured</span>{provider.authType !== "none" && counts.enabled !== counts.configured && <Badge variant="outline">{counts.enabled} enabled</Badge>}</div></TableCell><TableCell><div className="flex justify-end gap-1"><ConfirmAction title={`Delete ${provider.name}?`} description={`This permanently deletes ${counts.configured} API keys and ${modelCount} models attached to this provider.`} pending={isPending(`delete-provider:${provider.id}`)} onConfirm={() => onDeleteProviderList(provider)}><Trash2Icon /></ConfirmAction><Button nativeButton={false} aria-label={`Open ${provider.name}`} size="icon-sm" variant="ghost" render={<Link href={`/dashboard/providers/${provider.id}`} />}><ChevronRightIcon /></Button></div></TableCell></TableRow>
  })}{!providers.length && <EmptyRow label="No providers yet." colSpan={6} />}</TableBody></Table></CardContent></Card>
}

function ProviderDetail({ provider, apiKeys, modelCount, isPending, onAddKey, onEditProvider, onEditKey, onDeleteProvider, onDeleteKey }: {
  provider?: Provider
  apiKeys: ProviderApiKey[]
  modelCount: number
  isPending: (key: string) => boolean
  onAddKey: () => void
  onEditProvider: (provider: Provider) => void
  onEditKey: (apiKey: ProviderApiKey) => void
  onDeleteProvider: (provider: Provider) => Promise<boolean>
  onDeleteKey: (apiKey: ProviderApiKey) => Promise<boolean>
}) {
  if (!provider) return <Card><CardHeader><CardTitle>Provider not found</CardTitle><CardDescription>This provider may have been deleted or renamed.</CardDescription></CardHeader><CardContent><Button nativeButton={false} variant="outline" render={<Link href="/dashboard/providers" />}><ArrowLeftIcon />Back to providers</Button></CardContent></Card>
  const counts = countProviderApiKeys(provider.id, apiKeys)
  return <><div><Button nativeButton={false} variant="ghost" className="-ml-3 mb-3" render={<Link href="/dashboard/providers" />}><ArrowLeftIcon />Providers</Button><div><h2 className="text-2xl font-semibold tracking-tight">{provider.name}</h2><p className="mt-1 text-sm text-muted-foreground">{counts.configured} API {counts.configured === 1 ? "key" : "keys"} configured</p></div></div><Card><CardHeader><CardTitle>Provider details</CardTitle><CardDescription>{protocolLabels[provider.protocol]} · <span className="font-mono">{provider.baseUrl}</span></CardDescription><CardAction><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => onEditProvider(provider)}><PencilIcon />Edit</Button><ConfirmAction buttonLabel="Delete provider" title={`Delete ${provider.name}?`} description={`This permanently deletes ${counts.configured} API keys and ${modelCount} models attached to this provider.`} pending={isPending(`delete-provider:${provider.id}`)} onConfirm={() => onDeleteProvider(provider)}><Trash2Icon /></ConfirmAction></div></CardAction></CardHeader><CardContent><div className="grid gap-4 sm:grid-cols-3"><DetailValue label="Gateway prefix" value={`${provider.prefix}/`} mono /><DetailValue label="Authentication" value={provider.authType === "none" ? "None" : provider.authType} /><DetailValue label="Configured keys" value={String(counts.configured)} /></div></CardContent></Card><Card><CardHeader><CardTitle className="flex items-center gap-2"><KeyRoundIcon className="size-5" />API keys</CardTitle><CardDescription>Upstream credentials for this provider. Enabled keys currently rotate with basic round-robin.</CardDescription><CardAction><Button disabled={provider.authType === "none"} onClick={onAddKey}><PlusIcon />Add API key</Button></CardAction></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Credential</TableHead><TableHead>Status</TableHead><TableHead>Created</TableHead><TableHead /></TableRow></TableHeader><TableBody>{apiKeys.map((apiKey) => <TableRow key={apiKey.id}><TableCell className="font-medium">{apiKey.name}</TableCell><TableCell className="font-mono text-xs text-muted-foreground">Stored securely</TableCell><TableCell><Badge variant={apiKey.enabled ? "secondary" : "outline"}>{apiKey.enabled ? "Enabled" : "Disabled"}</Badge></TableCell><TableCell className="text-sm text-muted-foreground">{new Date(apiKey.createdAt).toLocaleDateString()}</TableCell><TableCell><div className="flex justify-end gap-1"><Button aria-label={`Edit ${apiKey.name}`} size="icon-sm" variant="ghost" onClick={() => onEditKey(apiKey)}><PencilIcon /></Button><ConfirmAction title={`Delete ${apiKey.name}?`} description="This credential will no longer be available for upstream requests." pending={isPending(`delete-provider-api-key:${apiKey.id}`)} onConfirm={() => onDeleteKey(apiKey)}><Trash2Icon /></ConfirmAction></div></TableCell></TableRow>)}{!apiKeys.length && <EmptyRow label={provider.authType === "none" ? "This provider does not require authentication." : "No API keys configured for this provider."} />}</TableBody></Table></CardContent></Card></>
}

function DetailValue({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="rounded-lg border bg-muted/20 p-4"><div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div><div className={`mt-2 text-sm font-medium ${mono ? "font-mono" : ""}`}>{value}</div></div>
}

function EmptyRow({ label, colSpan = 5 }: { label: string; colSpan?: number }) { return <TableRow><TableCell colSpan={colSpan} className="h-28 text-center text-muted-foreground">{label}</TableCell></TableRow> }

function maskApiKey(key: string) {
  if (key.length <= 12) return `${key.slice(0, 4)}${"•".repeat(Math.max(4, key.length - 4))}`
  return `${key.slice(0, 7)}${"•".repeat(20)}${key.slice(-4)}`
}

function ConfirmAction({ title, description, buttonLabel, pending, disabled, onConfirm, children }: { title: string; description: string; buttonLabel?: string; pending: boolean; disabled?: boolean; onConfirm: () => Promise<boolean>; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return <AlertDialog open={open} onOpenChange={setOpen}><Button aria-label={title} disabled={disabled || pending} size={buttonLabel ? "sm" : "icon-sm"} variant={buttonLabel ? "destructive" : "ghost"} onClick={() => setOpen(true)}>{pending ? <LoadingSpinner /> : children}{buttonLabel}</Button><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={pending} onClick={async () => { if (await onConfirm()) setOpen(false) }}>{pending && <LoadingSpinner />}{buttonLabel || "Delete"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
}

function EndpointValue() {
  const endpoint = typeof window === "undefined" ? "/v1" : `${window.location.origin}/v1`
  return <><code id="gateway-endpoint" suppressHydrationWarning className="min-w-0 flex-1 truncate text-sm">{endpoint}</code><script type={typeof window === "undefined" ? "text/javascript" : "text/plain"} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: '{var n=document.getElementById("gateway-endpoint");if(n)n.textContent=window.location.origin+"/v1"}' }} /></>
}

function ProviderForm({ provider, onSave }: { provider: Provider | null; onSave: (provider: Partial<Provider> & { originalId?: string }) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); const formData = new FormData(event.currentTarget); let headers = {}; try { headers = JSON.parse(String(formData.get("headers") || "{}")) } catch { toast.error("Headers must be valid JSON"); setPending(false); return } try { await onSave({ originalId: provider?.id, id: String(formData.get("prefix")), name: String(formData.get("name")), prefix: String(formData.get("prefix")), baseUrl: String(formData.get("baseUrl")), protocol: String(formData.get("protocol")) as Protocol, authType: String(formData.get("authType")) as Provider["authType"], authHeader: String(formData.get("authHeader") || ""), headers }) } finally { setPending(false) } }
  return <form onSubmit={submit}><DialogHeader><DialogTitle>{provider ? "Edit provider" : "Add provider"}</DialogTitle><DialogDescription>Configure the upstream origin first, then attach one or more API keys.</DialogDescription></DialogHeader><div className="grid gap-4 py-4"><FormField label="Name"><Input name="name" defaultValue={provider?.name} placeholder="OpenAI" required /></FormField><div className="grid gap-4 sm:grid-cols-2"><FormField label="Prefix"><Input name="prefix" defaultValue={provider?.prefix} placeholder="oa" required /></FormField><FormField label="Default protocol"><Select name="protocol" defaultValue={provider?.protocol || "openai-chat"}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent>{protocols.map((item) => <SelectItem key={item} value={item}>{protocolLabels[item]}</SelectItem>)}</SelectContent></Select></FormField></div><FormField label="Base URL"><Input name="baseUrl" defaultValue={provider?.baseUrl} type="url" placeholder="https://api.openai.com/v1" required /></FormField><div className="grid gap-4 sm:grid-cols-2"><FormField label="Authentication"><Select name="authType" defaultValue={provider?.authType || "bearer"}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="bearer">Bearer token</SelectItem><SelectItem value="x-api-key">x-api-key</SelectItem><SelectItem value="custom-header">Custom header</SelectItem><SelectItem value="none">None</SelectItem></SelectContent></Select></FormField><FormField label="Custom auth header"><Input name="authHeader" defaultValue={provider?.authHeader} placeholder="X-Provider-Key" /></FormField></div><FormField label="Static headers (JSON)"><Textarea name="headers" defaultValue={JSON.stringify(provider?.headers || {}, null, 2)} className="font-mono text-xs" /></FormField></div><DialogFooter><FormSubmitButton pending={pending} idleLabel={provider ? "Update provider" : "Save provider"} pendingLabel={provider ? "Updating provider..." : "Saving provider..."} /></DialogFooter></form>
}

function ProviderApiKeyForm({ providers, apiKey, onSave }: { providers: Provider[]; apiKey: ProviderApiKey | null; onSave: (apiKey: Partial<ProviderApiKey> & { originalId?: string }) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  const [enabled, setEnabled] = useState(apiKey?.enabled !== false)
  const scopedProvider = providers.length === 1 ? providers[0] : undefined
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    const formData = new FormData(event.currentTarget)
    try {
      await onSave({
        originalId: apiKey?.id,
        providerId: String(formData.get("providerId")),
        name: String(formData.get("name")),
        key: apiKey && !formData.get("key") ? "__unchanged__" : String(formData.get("key") || ""),
        enabled,
      })
    } finally { setPending(false) }
  }
  return <form onSubmit={submit}><DialogHeader><DialogTitle>{apiKey ? "Edit provider API key" : "Add provider API key"}</DialogTitle><DialogDescription>The credential value is never returned to the browser after saving.</DialogDescription></DialogHeader><div className="grid gap-4 py-4"><FormField label="Provider">{scopedProvider ? <><Input value={scopedProvider.name} readOnly className="bg-muted" /><input type="hidden" name="providerId" value={scopedProvider.id} /></> : <Select name="providerId" defaultValue={apiKey?.providerId || providers[0]?.id}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent>{providers.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</SelectContent></Select>}</FormField><FormField label="Key name"><Input name="name" defaultValue={apiKey?.name} maxLength={80} placeholder="Production key A" required /></FormField><FormField label="API key"><Input name="key" type="password" autoComplete="off" placeholder={apiKey ? "Leave blank to keep the current key" : "Enter upstream API key"} required={!apiKey} /></FormField><label className="flex items-center gap-3 rounded-lg border p-3"><Checkbox checked={enabled} onCheckedChange={setEnabled} /><span className="text-sm font-medium">Enabled for routing</span></label></div><DialogFooter><FormSubmitButton pending={pending} idleLabel={apiKey ? "Update API key" : "Add API key"} pendingLabel={apiKey ? "Updating..." : "Adding..."} /></DialogFooter></form>
}

function ModelForm({ providers, model, onSave }: { providers: Provider[]; model: Model | null; onSave: (model: Partial<Model> & { originalId?: string }) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  const [providerId, setProviderId] = useState(model?.providerId || providers[0]?.id || "")
  const [unprefixed, setUnprefixed] = useState(model?.unprefixed === true)
  const provider = providers.find((item) => item.id === providerId) || providers[0]
  const gatewaySuffix = model?.id.includes("/") ? model.id.slice(model.id.lastIndexOf("/") + 1) : model?.id
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const formData = new FormData(event.currentTarget); const protocol = String(formData.get("protocol")); let requestOverrides: Record<string, unknown> = {}; try { requestOverrides = JSON.parse(String(formData.get("requestOverrides") || "{}")); if (!requestOverrides || typeof requestOverrides !== "object" || Array.isArray(requestOverrides)) throw new Error() } catch { toast.error("Request body overrides must be a valid JSON object."); return } setPending(true); try { await onSave({ originalId: model?.id, id: String(formData.get("gatewayModelId")), providerId: String(formData.get("providerId")), name: String(formData.get("name")), upstreamModel: String(formData.get("upstreamModel")), unprefixed, protocol: protocol === "inherit" ? undefined : protocol as Protocol, upstreamPath: String(formData.get("upstreamPath") || ""), requestOverrides }) } finally { setPending(false) } }
  return <form onSubmit={submit}><DialogHeader><DialogTitle>{model ? "Edit model" : "Add model"}</DialogTitle><DialogDescription>Set the gateway-facing name and ID independently. Optional request overrides are merged without translating protocols.</DialogDescription></DialogHeader><div className="grid gap-4 py-4"><FormField label="Provider"><Select name="providerId" value={providerId} onValueChange={(value) => setProviderId(value || "")}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent>{providers.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name} ({provider.prefix}/)</SelectItem>)}</SelectContent></Select></FormField><div className="grid gap-4 sm:grid-cols-2"><FormField label="Model Name"><Input name="name" defaultValue={model?.name} placeholder="Halotec Pro" required /></FormField><FormField label="Gateway Model ID"><div className="flex h-9 overflow-hidden rounded-lg border border-input bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">{!unprefixed && <span className="flex shrink-0 items-center border-r bg-muted px-3 font-mono text-sm text-muted-foreground">{provider?.prefix || "provider"}/</span>}<Input name="gatewayModelId" defaultValue={gatewaySuffix} placeholder="halotec-pro" className="h-full rounded-none border-0 bg-transparent font-mono shadow-none focus-visible:ring-0" required /></div></FormField></div><label className="flex items-start gap-3 rounded-lg border p-3"><Checkbox checked={unprefixed} onCheckedChange={setUnprefixed} /><span><span className="block text-sm font-medium">Use without provider prefix</span><span className="block text-xs text-muted-foreground">Expose this ID directly. It must be unique across all models.</span></span></label><FormField label="Upstream Model ID"><Input name="upstreamModel" defaultValue={model?.upstreamModel} placeholder="gpt-5.3-codex" required /></FormField><FormField label="Protocol override"><Select name="protocol" defaultValue={model?.protocol || "inherit"}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">Inherit provider</SelectItem>{protocols.map((item) => <SelectItem key={item} value={item}>{protocolLabels[item]}</SelectItem>)}</SelectContent></Select></FormField><FormField label="Upstream path override"><Input name="upstreamPath" defaultValue={model?.upstreamPath} placeholder="Optional, e.g. /custom/infer" /></FormField><FormField label="Request body overrides (JSON)"><Textarea name="requestOverrides" defaultValue={JSON.stringify(model?.requestOverrides || {}, null, 2)} className="min-h-28 font-mono text-xs" spellCheck={false} /><p className="text-xs text-muted-foreground">Configured values always win. Responses example: {`{"reasoning":{"effort":"none"}}`}. Chat example: {`{"reasoning_effort":"none"}`}.</p></FormField></div><DialogFooter><FormSubmitButton pending={pending} idleLabel={model ? "Update model" : "Expose model"} pendingLabel={model ? "Updating model..." : "Exposing model..."} /></DialogFooter></form>
}

function PasswordDialog({ open, onSave }: { open: boolean; onSave: (password: string) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); const formData = new FormData(event.currentTarget); try { await onSave(String(formData.get("password"))) } finally { setPending(false) } }
  return <Dialog open={open}><DialogContent showCloseButton={false}><form onSubmit={submit}><DialogHeader><DialogTitle>Set a private admin password</DialogTitle><DialogDescription>You signed in with the default password. Change it before configuring the gateway.</DialogDescription></DialogHeader><div className="py-5"><FormField label="New password"><Input name="password" type="password" minLength={10} autoComplete="new-password" required /></FormField></div><DialogFooter><FormSubmitButton pending={pending} idleLabel="Change password" pendingLabel="Changing password..." /></DialogFooter></form></DialogContent></Dialog>
}

function ApiKeyForm({ onSave }: { onSave: (name: string) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    const formData = new FormData(event.currentTarget)
    try { await onSave(String(formData.get("name") || "").trim()) } finally { setPending(false) }
  }
  return <form onSubmit={submit}><DialogHeader><DialogTitle>Create API key</DialogTitle><DialogDescription>Give this key a recognizable name for the client or environment that will use it.</DialogDescription></DialogHeader><div className="py-5"><FormField label="Key Name"><Input name="name" maxLength={80} placeholder="Production gateway" autoFocus required /></FormField></div><DialogFooter><FormSubmitButton pending={pending} idleLabel="Create key" pendingLabel="Creating key..." /></DialogFooter></form>
}

function ChangePasswordForm({ onSave }: { onSave: (currentPassword: string, newPassword: string, confirmPassword: string) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    const currentPassword = String(formData.get("currentPassword") || "")
    const newPassword = String(formData.get("newPassword") || "")
    const confirmPassword = String(formData.get("confirmPassword") || "")
    if (newPassword !== confirmPassword) { toast.error("New passwords do not match."); return }
    setPending(true)
    try { if (await onSave(currentPassword, newPassword, confirmPassword)) form.reset() } finally { setPending(false) }
  }
  return <form className="grid gap-5" onSubmit={submit}><FormField label="Current password"><Input name="currentPassword" type="password" autoComplete="current-password" required /></FormField><FormField label="New password"><Input name="newPassword" type="password" minLength={10} autoComplete="new-password" required /></FormField><FormField label="Confirm new password"><Input name="confirmPassword" type="password" minLength={10} autoComplete="new-password" required /></FormField><div><FormSubmitButton pending={pending} idleLabel="Update password" pendingLabel="Updating password..." /></div></form>
}

function FormSubmitButton({ pending, idleLabel, pendingLabel }: { pending: boolean; idleLabel: string; pendingLabel: string }) {
  return <Button aria-busy={pending} disabled={pending} type="submit">{pending && <LoadingSpinner />}{pending ? pendingLabel : idleLabel}</Button>
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) { return <div className="grid gap-2"><Label>{label}</Label>{children}</div> }
