"use client"

import { useCallback, useState } from "react"
import { BoxesIcon, CopyIcon, KeyRoundIcon, PlusIcon, RouteIcon, ServerIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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

function NativeSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-ring" />
}

export function GatewayDashboard({ initialState }: { initialState: State }) {
  const [state, setState] = useState<State>(initialState)
  const [providerOpen, setProviderOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const load = useCallback(async () => {
    const response = await fetch("/api/admin/state", { cache: "no-store" })
    if (response.ok) setState(await response.json())
  }, [])

  async function run(payload: Record<string, unknown>, message: string) {
    try { await action(payload); toast.success(message); await load() } catch (error) { toast.error(error instanceof Error ? error.message : "Request failed") }
  }

  return <SidebarProvider style={{ "--sidebar-width": "17rem", "--header-height": "3rem" } as React.CSSProperties}>
    <AppSidebar variant="inset" />
    <SidebarInset><SiteHeader /><main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-8">
        <section id="overview" className="overflow-hidden rounded-2xl border bg-slate-950 p-6 text-white shadow-xl shadow-slate-950/10 md:p-8">
          <div className="grid gap-8 md:grid-cols-[1.5fr_1fr]"><div><Badge className="mb-4 bg-amber-300 text-slate-950 hover:bg-amber-300">Zero translation</Badge><h2 className="max-w-2xl text-3xl font-semibold tracking-tight md:text-5xl">One catalog. Three native protocols.</h2><p className="mt-4 max-w-2xl text-sm leading-6 text-slate-300">RawRoute changes only the model ID, injects upstream authentication, and pipes the provider response back untouched.</p></div><div className="grid grid-cols-3 gap-3 self-end">{[[state.providers.length,"Providers"],[state.models.length,"Models"],[state.apiKeys.length,"Keys"]].map(([value,label]) => <div key={label} className="rounded-xl border border-white/10 bg-white/5 p-4"><div className="text-3xl font-semibold">{value}</div><div className="mt-1 text-xs text-slate-400">{label}</div></div>)}</div></div>
        </section>

        <Tabs defaultValue="providers">
          <TabsList><TabsTrigger value="providers"><ServerIcon />Providers</TabsTrigger><TabsTrigger value="models"><BoxesIcon />Models</TabsTrigger><TabsTrigger value="keys"><KeyRoundIcon />API keys</TabsTrigger></TabsList>
          <TabsContent value="providers" id="providers"><Card><CardHeader className="flex-row items-start justify-between"><div><CardTitle>Providers</CardTitle><CardDescription>Upstream origins, authentication, and default native protocol.</CardDescription></div><Dialog open={providerOpen} onOpenChange={setProviderOpen}><DialogTrigger render={<Button><PlusIcon />Add provider</Button>} /><DialogContent><ProviderForm onSave={async (provider) => { await run({ action: "save-provider", provider }, "Provider saved"); setProviderOpen(false) }} /></DialogContent></Dialog></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Provider</TableHead><TableHead>Prefix</TableHead><TableHead>Protocol</TableHead><TableHead>Origin</TableHead><TableHead /></TableRow></TableHeader><TableBody>{state.providers.map((provider) => <TableRow key={provider.id}><TableCell className="font-medium">{provider.name}</TableCell><TableCell><Badge variant="secondary">{provider.prefix}/</Badge></TableCell><TableCell>{protocolLabels[provider.protocol]}</TableCell><TableCell className="max-w-64 truncate font-mono text-xs">{provider.baseUrl}</TableCell><TableCell className="text-right"><Button size="icon-sm" variant="ghost" onClick={() => run({ action: "delete-provider", id: provider.id }, "Provider deleted")}><Trash2Icon /></Button></TableCell></TableRow>)}{!state.providers.length && <EmptyRow label="No providers yet." />}</TableBody></Table></CardContent></Card></TabsContent>
          <TabsContent value="models" id="models"><Card><CardHeader className="flex-row items-start justify-between"><div><CardTitle>Models</CardTitle><CardDescription>Public prefixed IDs mapped to exact upstream model IDs.</CardDescription></div><Dialog open={modelOpen} onOpenChange={setModelOpen}><DialogTrigger render={<Button disabled={!state.providers.length}><PlusIcon />Add model</Button>} /><DialogContent><ModelForm providers={state.providers} onSave={async (model) => { await run({ action: "save-model", model }, "Model saved"); setModelOpen(false) }} /></DialogContent></Dialog></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Gateway ID</TableHead><TableHead>Upstream model</TableHead><TableHead>Protocol</TableHead><TableHead /></TableRow></TableHeader><TableBody>{state.models.map((model) => { const provider = state.providers.find((item) => item.id === model.providerId); return <TableRow key={model.id}><TableCell className="font-mono text-xs font-medium">{model.id}</TableCell><TableCell>{model.upstreamModel}</TableCell><TableCell>{protocolLabels[model.protocol || provider?.protocol || "openai-chat"]}{model.protocol && <Badge variant="outline" className="ml-2">override</Badge>}</TableCell><TableCell className="text-right"><Button size="icon-sm" variant="ghost" onClick={() => run({ action: "delete-model", id: model.id }, "Model deleted")}><Trash2Icon /></Button></TableCell></TableRow> })}{!state.models.length && <EmptyRow label="Add a provider, then expose its first model." />}</TableBody></Table></CardContent></Card></TabsContent>
          <TabsContent value="keys" id="keys"><Card><CardHeader className="flex-row items-start justify-between"><div><CardTitle>Gateway API keys</CardTitle><CardDescription>Clients use these keys to access every proxy endpoint.</CardDescription></div><Button onClick={() => run({ action: "create-api-key", name: `Gateway key ${state.apiKeys.length + 1}` }, "API key created")}><PlusIcon />Create key</Button></CardHeader><CardContent className="space-y-3">{state.apiKeys.map((key) => <div key={key.id} className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3"><div className="min-w-0 flex-1"><div className="text-sm font-medium">{key.name}</div><code className="block truncate text-xs text-muted-foreground">{key.key}</code></div><Button size="icon-sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(key.key); toast.success("Copied") }}><CopyIcon /></Button><Button size="icon-sm" variant="ghost" disabled={state.apiKeys.length === 1} onClick={() => run({ action: "delete-api-key", id: key.id }, "API key deleted")}><Trash2Icon /></Button></div>)}</CardContent></Card></TabsContent>
        </Tabs>
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><RouteIcon className="size-5" />Native endpoints</CardTitle><CardDescription>Clients must call the endpoint matching the configured model protocol.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-3">{protocols.map((protocol) => <div key={protocol} className="rounded-lg border bg-background p-4"><div className="text-sm font-medium">{protocolLabels[protocol]}</div><code className="mt-2 block text-xs text-muted-foreground">POST {protocol === "openai-chat" ? "/v1/chat/completions" : protocol === "openai-responses" ? "/v1/responses" : "/v1/messages"}</code></div>)}</CardContent></Card>
      </div>
    </main></SidebarInset>
    <PasswordDialog open={state.admin.mustChangePassword} onSave={async (password) => { await run({ action: "change-password", password }, "Password changed") }} />
  </SidebarProvider>
}

function EmptyRow({ label }: { label: string }) { return <TableRow><TableCell colSpan={5} className="h-28 text-center text-muted-foreground">{label}</TableCell></TableRow> }

function ProviderForm({ onSave }: { onSave: (provider: Partial<Provider>) => Promise<void> }) {
  return <form action={async (formData) => { let headers = {}; try { headers = JSON.parse(String(formData.get("headers") || "{}")) } catch { toast.error("Headers must be valid JSON"); return }; await onSave({ id: String(formData.get("prefix")), name: String(formData.get("name")), prefix: String(formData.get("prefix")), baseUrl: String(formData.get("baseUrl")), protocol: String(formData.get("protocol")) as Protocol, authType: String(formData.get("authType")) as Provider["authType"], authHeader: String(formData.get("authHeader") || ""), secret: String(formData.get("secret") || ""), headers }) }}><DialogHeader><DialogTitle>Add provider</DialogTitle><DialogDescription>RawRoute will never translate this provider&apos;s payload format.</DialogDescription></DialogHeader><div className="grid gap-4 py-4"><FormField label="Name"><Input name="name" placeholder="OpenAI" required /></FormField><div className="grid grid-cols-2 gap-4"><FormField label="Prefix"><Input name="prefix" placeholder="oa" required /></FormField><FormField label="Default protocol"><NativeSelect name="protocol">{protocols.map((item) => <option key={item} value={item}>{protocolLabels[item]}</option>)}</NativeSelect></FormField></div><FormField label="Base URL"><Input name="baseUrl" type="url" placeholder="https://api.openai.com/v1" required /></FormField><div className="grid grid-cols-2 gap-4"><FormField label="Authentication"><NativeSelect name="authType"><option value="bearer">Bearer token</option><option value="x-api-key">x-api-key</option><option value="custom-header">Custom header</option><option value="none">None</option></NativeSelect></FormField><FormField label="Custom auth header"><Input name="authHeader" placeholder="X-Provider-Key" /></FormField></div><FormField label="Secret"><Input name="secret" type="password" autoComplete="off" /></FormField><FormField label="Static headers (JSON)"><Textarea name="headers" defaultValue="{}" className="font-mono text-xs" /></FormField></div><DialogFooter><Button type="submit">Save provider</Button></DialogFooter></form>
}

function ModelForm({ providers, onSave }: { providers: Provider[]; onSave: (model: Partial<Model>) => Promise<void> }) {
  return <form action={async (formData) => onSave({ providerId: String(formData.get("providerId")), name: String(formData.get("name")), upstreamModel: String(formData.get("upstreamModel")), protocol: (String(formData.get("protocol")) || undefined) as Protocol | undefined, upstreamPath: String(formData.get("upstreamPath") || "") })}><DialogHeader><DialogTitle>Add model</DialogTitle><DialogDescription>The public ID becomes prefix/name. Only its model field is rewritten upstream.</DialogDescription></DialogHeader><div className="grid gap-4 py-4"><FormField label="Provider"><NativeSelect name="providerId">{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} ({provider.prefix}/)</option>)}</NativeSelect></FormField><div className="grid grid-cols-2 gap-4"><FormField label="Public name"><Input name="name" placeholder="gpt-codex" required /></FormField><FormField label="Upstream model ID"><Input name="upstreamModel" placeholder="gpt-5.3-codex" required /></FormField></div><FormField label="Protocol override"><NativeSelect name="protocol"><option value="">Inherit provider</option>{protocols.map((item) => <option key={item} value={item}>{protocolLabels[item]}</option>)}</NativeSelect></FormField><FormField label="Upstream path override"><Input name="upstreamPath" placeholder="Optional, e.g. /custom/infer" /></FormField></div><DialogFooter><Button type="submit">Expose model</Button></DialogFooter></form>
}

function PasswordDialog({ open, onSave }: { open: boolean; onSave: (password: string) => Promise<void> }) {
  return <Dialog open={open}><DialogContent showCloseButton={false}><form action={async (formData) => onSave(String(formData.get("password")))}><DialogHeader><DialogTitle>Set a private admin password</DialogTitle><DialogDescription>You signed in with the default password. Change it before configuring the gateway.</DialogDescription></DialogHeader><div className="py-5"><FormField label="New password"><Input name="password" type="password" minLength={10} autoComplete="new-password" required /></FormField></div><DialogFooter><Button type="submit">Change password</Button></DialogFooter></form></DialogContent></Dialog>
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) { return <div className="grid gap-2"><Label>{label}</Label>{children}</div> }
