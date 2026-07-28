"use client"

import { useState, type FormEvent } from "react"
import { CopyIcon, PencilIcon, PlusIcon, RouteIcon, Trash2Icon } from "lucide-react"
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
import { protocolLabels, type ApiKey, type Model, type Protocol, type Provider } from "@/lib/types"

type State = { admin: { username: string; mustChangePassword: boolean }; providers: Provider[]; models: Model[]; apiKeys: ApiKey[] }
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

export function GatewayDashboard({ view }: { view: "endpoint-key" | "providers" | "models" }) {
  const { data: state, error, isLoading, mutate } = useSWR("/api/admin/state", fetchState, { revalidateOnFocus: false })
  const [providerOpen, setProviderOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
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
        {view === "providers" && <Card><CardHeader><CardTitle>Providers</CardTitle><CardDescription>Upstream origins, authentication, and default native protocol.</CardDescription><CardAction><Button onClick={() => { setEditingProvider(null); setProviderOpen(true) }}><PlusIcon />Add provider</Button></CardAction></CardHeader><Dialog open={providerOpen} onOpenChange={(open) => { setProviderOpen(open); if (!open) setEditingProvider(null) }}><DialogContent><ProviderForm key={editingProvider?.id || "new"} provider={editingProvider} onSave={async (provider) => { const saved = await run({ action: "save-provider", provider }, editingProvider ? "Provider updated" : "Provider saved", "save-provider"); if (saved) setProviderOpen(false); return saved }} /></DialogContent></Dialog><CardContent><Table><TableHeader><TableRow><TableHead>Provider</TableHead><TableHead>Prefix</TableHead><TableHead>Protocol</TableHead><TableHead>Origin</TableHead><TableHead /></TableRow></TableHeader><TableBody>{state.providers.map((provider) => { const pendingKey = `delete-provider:${provider.id}`; return <TableRow key={provider.id}><TableCell className="font-medium">{provider.name}</TableCell><TableCell><Badge variant="secondary">{provider.prefix}/</Badge></TableCell><TableCell>{protocolLabels[provider.protocol]}</TableCell><TableCell className="max-w-64 truncate font-mono text-xs">{provider.baseUrl}</TableCell><TableCell><div className="flex justify-end gap-1"><Button aria-label={`Edit ${provider.name}`} size="icon-sm" variant="ghost" onClick={() => { setEditingProvider(provider); setProviderOpen(true) }}><PencilIcon /></Button><ConfirmAction title={`Delete ${provider.name}?`} description="This also deletes every model attached to this provider." pending={isPending(pendingKey)} onConfirm={() => run({ action: "delete-provider", id: provider.id }, "Provider deleted", pendingKey)}><Trash2Icon /></ConfirmAction></div></TableCell></TableRow> })}{!state.providers.length && <EmptyRow label="No providers yet." />}</TableBody></Table></CardContent></Card>}
        {view === "models" && <Card><CardHeader><CardTitle>Models</CardTitle><CardDescription>Gateway IDs mapped to exact upstream model IDs.</CardDescription><CardAction><Button disabled={!state.providers.length} onClick={() => { setEditingModel(null); setModelOpen(true) }}><PlusIcon />Add model</Button></CardAction></CardHeader><Dialog open={modelOpen} onOpenChange={(open) => { setModelOpen(open); if (!open) setEditingModel(null) }}><DialogContent><ModelForm key={editingModel?.id || "new"} providers={state.providers} model={editingModel} onSave={async (model) => { const saved = await run({ action: "save-model", model }, editingModel ? "Model updated" : "Model saved", "save-model"); if (saved) setModelOpen(false); return saved }} /></DialogContent></Dialog><CardContent><Table><TableHeader><TableRow><TableHead>Model</TableHead><TableHead>Gateway ID</TableHead><TableHead>Upstream model</TableHead><TableHead>Protocol</TableHead><TableHead /></TableRow></TableHeader><TableBody>{state.models.map((model) => { const provider = state.providers.find((item) => item.id === model.providerId); const pendingKey = `delete-model:${model.id}`; return <TableRow key={model.id}><TableCell className="font-medium">{model.name}</TableCell><TableCell className="font-mono text-xs font-medium">{model.id}{model.unprefixed && <Badge variant="outline" className="ml-2">no prefix</Badge>}</TableCell><TableCell>{model.upstreamModel}</TableCell><TableCell>{protocolLabels[model.protocol || provider?.protocol || "openai-chat"]}{model.protocol && <Badge variant="outline" className="ml-2">override</Badge>}</TableCell><TableCell><div className="flex justify-end gap-1"><Button aria-label={`Edit ${model.id}`} size="icon-sm" variant="ghost" onClick={() => { setEditingModel(model); setModelOpen(true) }}><PencilIcon /></Button><ConfirmAction title={`Delete ${model.id}?`} description="Requests using this gateway model ID will stop working." pending={isPending(pendingKey)} onConfirm={() => run({ action: "delete-model", id: model.id }, "Model deleted", pendingKey)}><Trash2Icon /></ConfirmAction></div></TableCell></TableRow> })}{!state.models.length && <EmptyRow label="Add a provider, then expose its first model." />}</TableBody></Table></CardContent></Card>}
        {view === "endpoint-key" && <><Card><CardHeader><CardTitle className="flex items-center gap-2"><RouteIcon className="size-5" />API Endpoint</CardTitle><CardDescription>Use this base URL with the native protocol endpoint supported by each model.</CardDescription></CardHeader><CardContent><div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3"><Badge variant="secondary" className="shrink-0">Gateway</Badge><EndpointValue /><Button aria-label="Copy API endpoint" size="icon-sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}/v1`); toast.success("Endpoint copied") }}><CopyIcon /></Button></div></CardContent></Card><Card><CardHeader><CardTitle>Gateway API keys</CardTitle><CardDescription>Clients use these keys to access every proxy endpoint.</CardDescription><CardAction><Button aria-busy={isPending("create-api-key")} disabled={isPending("create-api-key")} onClick={() => run({ action: "create-api-key", name: `Gateway key ${state.apiKeys.length + 1}` }, "API key created", "create-api-key")}>{isPending("create-api-key") ? <LoadingSpinner /> : <PlusIcon />}{isPending("create-api-key") ? "Creating..." : "Create key"}</Button></CardAction></CardHeader><CardContent className="space-y-3">{state.apiKeys.map((key) => { const pendingKey = `delete-api-key:${key.id}`; return <div key={key.id} className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3"><div className="min-w-0 flex-1"><div className="text-sm font-medium">{key.name}</div><code className="block truncate text-xs text-muted-foreground">{maskApiKey(key.key)}</code></div><Button aria-label={`Copy ${key.name}`} size="icon-sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(key.key); toast.success("Copied") }}><CopyIcon /></Button><ConfirmAction title={`Delete ${key.name}?`} description="Clients using this key will immediately lose access." pending={isPending(pendingKey)} disabled={state.apiKeys.length === 1} onConfirm={() => run({ action: "delete-api-key", id: key.id }, "API key deleted", pendingKey)}><Trash2Icon /></ConfirmAction></div> })}</CardContent></Card></>}
      </div>

    <PasswordDialog open={state.admin.mustChangePassword} onSave={(password) => run({ action: "change-password", password }, "Password changed", "change-password")} />
  </main>
}

function EmptyRow({ label }: { label: string }) { return <TableRow><TableCell colSpan={5} className="h-28 text-center text-muted-foreground">{label}</TableCell></TableRow> }

function maskApiKey(key: string) {
  if (key.length <= 12) return `${key.slice(0, 4)}${"•".repeat(Math.max(4, key.length - 4))}`
  return `${key.slice(0, 7)}${"•".repeat(20)}${key.slice(-4)}`
}

function ConfirmAction({ title, description, pending, disabled, onConfirm, children }: { title: string; description: string; pending: boolean; disabled?: boolean; onConfirm: () => Promise<boolean>; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return <AlertDialog open={open} onOpenChange={setOpen}><Button aria-label={title} disabled={disabled || pending} size="icon-sm" variant="ghost" onClick={() => setOpen(true)}>{pending ? <LoadingSpinner /> : children}</Button><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={pending} onClick={async () => { if (await onConfirm()) setOpen(false) }}>{pending && <LoadingSpinner />}Delete</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
}

function EndpointValue() {
  const endpoint = typeof window === "undefined" ? "/v1" : `${window.location.origin}/v1`
  return <><code id="gateway-endpoint" suppressHydrationWarning className="min-w-0 flex-1 truncate text-sm">{endpoint}</code><script type={typeof window === "undefined" ? "text/javascript" : "text/plain"} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: '{var n=document.getElementById("gateway-endpoint");if(n)n.textContent=window.location.origin+"/v1"}' }} /></>
}

function ProviderForm({ provider, onSave }: { provider: Provider | null; onSave: (provider: Partial<Provider> & { originalId?: string }) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); const formData = new FormData(event.currentTarget); let headers = {}; try { headers = JSON.parse(String(formData.get("headers") || "{}")) } catch { toast.error("Headers must be valid JSON"); setPending(false); return } try { await onSave({ originalId: provider?.id, id: String(formData.get("prefix")), name: String(formData.get("name")), prefix: String(formData.get("prefix")), baseUrl: String(formData.get("baseUrl")), protocol: String(formData.get("protocol")) as Protocol, authType: String(formData.get("authType")) as Provider["authType"], authHeader: String(formData.get("authHeader") || ""), secret: provider && !formData.get("secret") ? "__unchanged__" : String(formData.get("secret") || ""), headers }) } finally { setPending(false) } }
  return <form onSubmit={submit}><DialogHeader><DialogTitle>{provider ? "Edit provider" : "Add provider"}</DialogTitle><DialogDescription>RawRoute will never translate this provider&apos;s payload format.</DialogDescription></DialogHeader><div className="grid gap-4 py-4"><FormField label="Name"><Input name="name" defaultValue={provider?.name} placeholder="OpenAI" required /></FormField><div className="grid gap-4 sm:grid-cols-2"><FormField label="Prefix"><Input name="prefix" defaultValue={provider?.prefix} placeholder="oa" required /></FormField><FormField label="Default protocol"><Select name="protocol" defaultValue={provider?.protocol || "openai-chat"}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent>{protocols.map((item) => <SelectItem key={item} value={item}>{protocolLabels[item]}</SelectItem>)}</SelectContent></Select></FormField></div><FormField label="Base URL"><Input name="baseUrl" defaultValue={provider?.baseUrl} type="url" placeholder="https://api.openai.com/v1" required /></FormField><div className="grid gap-4 sm:grid-cols-2"><FormField label="Authentication"><Select name="authType" defaultValue={provider?.authType || "bearer"}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="bearer">Bearer token</SelectItem><SelectItem value="x-api-key">x-api-key</SelectItem><SelectItem value="custom-header">Custom header</SelectItem><SelectItem value="none">None</SelectItem></SelectContent></Select></FormField><FormField label="Custom auth header"><Input name="authHeader" defaultValue={provider?.authHeader} placeholder="X-Provider-Key" /></FormField></div><FormField label="Secret"><Input name="secret" type="password" autoComplete="off" placeholder={provider?.secret ? "Leave blank to keep existing secret" : undefined} /></FormField><FormField label="Static headers (JSON)"><Textarea name="headers" defaultValue={JSON.stringify(provider?.headers || {}, null, 2)} className="font-mono text-xs" /></FormField></div><DialogFooter><FormSubmitButton pending={pending} idleLabel={provider ? "Update provider" : "Save provider"} pendingLabel={provider ? "Updating provider..." : "Saving provider..."} /></DialogFooter></form>
}

function ModelForm({ providers, model, onSave }: { providers: Provider[]; model: Model | null; onSave: (model: Partial<Model> & { originalId?: string }) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  const [providerId, setProviderId] = useState(model?.providerId || providers[0]?.id || "")
  const [unprefixed, setUnprefixed] = useState(model?.unprefixed === true)
  const provider = providers.find((item) => item.id === providerId) || providers[0]
  const gatewaySuffix = model?.id.includes("/") ? model.id.slice(model.id.lastIndexOf("/") + 1) : model?.id
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); const formData = new FormData(event.currentTarget); const protocol = String(formData.get("protocol")); try { await onSave({ originalId: model?.id, id: String(formData.get("gatewayModelId")), providerId: String(formData.get("providerId")), name: String(formData.get("name")), upstreamModel: String(formData.get("upstreamModel")), unprefixed, protocol: protocol === "inherit" ? undefined : protocol as Protocol, upstreamPath: String(formData.get("upstreamPath") || "") }) } finally { setPending(false) } }
  return <form onSubmit={submit}><DialogHeader><DialogTitle>{model ? "Edit model" : "Add model"}</DialogTitle><DialogDescription>Set the gateway-facing name and ID independently. Only the upstream model field is rewritten.</DialogDescription></DialogHeader><div className="grid gap-4 py-4"><FormField label="Provider"><Select name="providerId" value={providerId} onValueChange={(value) => setProviderId(value || "")}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent>{providers.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name} ({provider.prefix}/)</SelectItem>)}</SelectContent></Select></FormField><div className="grid gap-4 sm:grid-cols-2"><FormField label="Model Name"><Input name="name" defaultValue={model?.name} placeholder="Halotec Pro" required /></FormField><FormField label="Gateway Model ID"><div className="flex h-9 overflow-hidden rounded-lg border border-input bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">{!unprefixed && <span className="flex shrink-0 items-center border-r bg-muted px-3 font-mono text-sm text-muted-foreground">{provider?.prefix || "provider"}/</span>}<Input name="gatewayModelId" defaultValue={gatewaySuffix} placeholder="halotec-pro" className="h-full rounded-none border-0 bg-transparent font-mono shadow-none focus-visible:ring-0" required /></div></FormField></div><label className="flex items-start gap-3 rounded-lg border p-3"><Checkbox checked={unprefixed} onCheckedChange={setUnprefixed} /><span><span className="block text-sm font-medium">Use without provider prefix</span><span className="block text-xs text-muted-foreground">Expose this ID directly. It must be unique across all models.</span></span></label><FormField label="Upstream Model ID"><Input name="upstreamModel" defaultValue={model?.upstreamModel} placeholder="gpt-5.3-codex" required /></FormField><FormField label="Protocol override"><Select name="protocol" defaultValue={model?.protocol || "inherit"}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">Inherit provider</SelectItem>{protocols.map((item) => <SelectItem key={item} value={item}>{protocolLabels[item]}</SelectItem>)}</SelectContent></Select></FormField><FormField label="Upstream path override"><Input name="upstreamPath" defaultValue={model?.upstreamPath} placeholder="Optional, e.g. /custom/infer" /></FormField></div><DialogFooter><FormSubmitButton pending={pending} idleLabel={model ? "Update model" : "Expose model"} pendingLabel={model ? "Updating model..." : "Exposing model..."} /></DialogFooter></form>
}

function PasswordDialog({ open, onSave }: { open: boolean; onSave: (password: string) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); const formData = new FormData(event.currentTarget); try { await onSave(String(formData.get("password"))) } finally { setPending(false) } }
  return <Dialog open={open}><DialogContent showCloseButton={false}><form onSubmit={submit}><DialogHeader><DialogTitle>Set a private admin password</DialogTitle><DialogDescription>You signed in with the default password. Change it before configuring the gateway.</DialogDescription></DialogHeader><div className="py-5"><FormField label="New password"><Input name="password" type="password" minLength={10} autoComplete="new-password" required /></FormField></div><DialogFooter><FormSubmitButton pending={pending} idleLabel="Change password" pendingLabel="Changing password..." /></DialogFooter></form></DialogContent></Dialog>
}

function FormSubmitButton({ pending, idleLabel, pendingLabel }: { pending: boolean; idleLabel: string; pendingLabel: string }) {
  return <Button aria-busy={pending} disabled={pending} type="submit">{pending && <LoadingSpinner />}{pending ? pendingLabel : idleLabel}</Button>
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) { return <div className="grid gap-2"><Label>{label}</Label>{children}</div> }
