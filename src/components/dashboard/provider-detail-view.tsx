"use client"

import { useState } from "react"
import { ArrowLeftIcon, BoxesIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, KeyRoundIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import useSWR, { mutate as globalMutate } from "swr"
import { toast } from "sonner"

import { ConfirmAction, DetailValue, EmptyRow, NotFoundState } from "@/components/dashboard/shared"
import { ModelForm } from "@/components/dashboard/model-form"
import { ProviderApiKeyForm } from "@/components/dashboard/provider-api-key-form"
import { ProviderForm } from "@/components/dashboard/provider-form"
import { apiDelete, apiPost } from "@/components/dashboard/api"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { protocolLabels, type Model, type Provider, type ProviderApiKey } from "@/lib/types"

type ProviderDetailResponse = { provider: Provider; apiKeys: ProviderApiKey[]; models: Model[] }
const providerKey = (providerId: string) => `/api/admin/providers/${encodeURIComponent(providerId)}`

export function ProviderDetailView({ providerId }: { providerId: string }) {
  const router = useRouter()
  const { data, error, isLoading, mutate } = useSWR<ProviderDetailResponse>(providerKey(providerId))
  const [providerOpen, setProviderOpen] = useState(false)
  const [providerKeyOpen, setProviderKeyOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [editingProviderApiKey, setEditingProviderApiKey] = useState<ProviderApiKey | null>(null)
  const [editingModel, setEditingModel] = useState<Model | null>(null)
  const [pending, setPending] = useState<Set<string>>(() => new Set())

  if (error) return <NotFoundState onBack={() => router.push("/dashboard/providers")} />
  if (isLoading || !data) return <DashboardContentSkeleton variant="provider-detail" />

  const isPending = (key: string) => pending.has(key)

  async function saveProvider(provider: Partial<Provider> & { originalId?: string }) {
    setPending((current) => new Set(current).add("save-provider"))
    try {
      await apiPost("/api/admin/providers", { provider })
      toast.success(editingProvider ? "Provider updated" : "Provider saved")
      await mutate()
      await globalMutate("/api/admin/providers")
      setProviderOpen(false)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete("save-provider"); return next })
    }
  }

  async function deleteProvider(provider: Provider) {
    const pendingKey = `delete-provider:${provider.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiDelete(`/api/admin/providers/${provider.id}`)
      toast.success("Provider deleted")
      await globalMutate("/api/admin/providers")
      router.push("/dashboard/providers")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }

  async function saveProviderApiKey(apiKey: Partial<ProviderApiKey> & { originalId?: string }) {
    setPending((current) => new Set(current).add("save-provider-api-key"))
    try {
      await apiPost(`/api/admin/providers/${providerId}/api-keys`, { providerApiKey: apiKey })
      toast.success(editingProviderApiKey ? "Provider API key updated" : "Provider API key added")
      await mutate()
      await globalMutate("/api/admin/providers")
      setProviderKeyOpen(false)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete("save-provider-api-key"); return next })
    }
  }

  async function deleteProviderApiKey(apiKey: ProviderApiKey) {
    const pendingKey = `delete-provider-api-key:${apiKey.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiDelete(`/api/admin/providers/${providerId}/api-keys/${apiKey.id}`)
      toast.success("Provider API key deleted")
      await mutate()
      await globalMutate("/api/admin/providers")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }

  async function moveProviderApiKey(index: number, direction: -1 | 1) {
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= apiKeys.length) return
    const orderedIds = apiKeys.map((apiKey) => apiKey.id)
    ;[orderedIds[index], orderedIds[nextIndex]] = [orderedIds[nextIndex], orderedIds[index]]
    const pendingKey = `move-provider-api-key:${apiKeys[index].id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiPost(`/api/admin/providers/${providerId}/api-keys/reorder`, { orderedIds })
      await mutate()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }

  async function saveModel(model: Partial<Model> & { originalId?: string }) {
    setPending((current) => new Set(current).add("save-model"))
    try {
      await apiPost(`/api/admin/providers/${providerId}/models`, { model })
      toast.success(editingModel ? "Model updated" : "Model saved")
      await mutate()
      await globalMutate("/api/admin/providers")
      setModelOpen(false)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete("save-model"); return next })
    }
  }

  async function deleteModel(model: Model) {
    const pendingKey = `delete-model:${model.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiDelete(`/api/admin/providers/${providerId}/models/${encodeURIComponent(model.id)}`)
      toast.success("Model deleted")
      await mutate()
      await globalMutate("/api/admin/providers")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }

  const { provider, apiKeys, models } = data
  const apiKeyCounts = {
    configured: apiKeys.length,
    enabled: apiKeys.filter((apiKey) => apiKey.enabled).length,
  }

  return <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
    <div className="mx-auto flex max-w-7xl flex-col gap-8">
      <div>
        <Button nativeButton={false} variant="ghost" className="-ml-3 mb-3" render={<Link href="/dashboard/providers" />}><ArrowLeftIcon />Providers</Button>
        <div><h2 className="text-2xl font-semibold tracking-tight">{provider.name}</h2><p className="mt-1 text-sm text-muted-foreground">{apiKeyCounts.configured} API {apiKeyCounts.configured === 1 ? "key" : "keys"} configured</p></div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Provider details</CardTitle>
          <CardDescription><span className="font-mono">{provider.baseUrl}</span></CardDescription>
          <CardAction>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => { setEditingProvider(provider); setProviderOpen(true) }}><PencilIcon />Edit</Button>
              <ConfirmAction buttonLabel="Delete provider" title={`Delete ${provider.name}?`} description={`This permanently deletes ${apiKeyCounts.configured} API keys and ${models.length} models attached to this provider.`} pending={isPending(`delete-provider:${provider.id}`)} onConfirm={() => deleteProvider(provider)}><Trash2Icon /></ConfirmAction>
            </div>
          </CardAction>
        </CardHeader>
        <Dialog open={providerOpen} onOpenChange={(open) => { setProviderOpen(open); if (!open) setEditingProvider(null) }}>
          <DialogContent>
            <ProviderForm key={editingProvider?.id || "new"} provider={editingProvider} onSave={saveProvider} />
          </DialogContent>
        </Dialog>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <DetailValue label="Gateway prefix" value={`${provider.prefix}/`} mono />
            <DetailValue label="Authentication" value={provider.authType === "none" ? "None" : provider.authType} />
            <DetailValue label="Protocol" value={protocolLabels[provider.protocol]} />
            <DetailValue label="Configured keys" value={String(apiKeyCounts.configured)} />
            <DetailValue label="Configured models" value={String(models.length)} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><KeyRoundIcon className="size-5" />API keys</CardTitle>
          <CardDescription>Sticky least-loaded routing keeps sessions warm while distributing new work by capacity.</CardDescription>
          <CardAction><Button disabled={provider.authType === "none"} onClick={() => { setEditingProviderApiKey(null); setProviderKeyOpen(true) }}><PlusIcon />Add API key</Button></CardAction>
        </CardHeader>
        <Dialog open={providerKeyOpen} onOpenChange={(open) => { setProviderKeyOpen(open); if (!open) setEditingProviderApiKey(null) }}>
          <DialogContent>
            <ProviderApiKeyForm key={editingProviderApiKey?.id || "new"} providers={[provider]} apiKey={editingProviderApiKey} onSave={saveProviderApiKey} />
          </DialogContent>
        </Dialog>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20" />
                <TableHead>Name</TableHead>
                <TableHead>Limits</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiKeys.map((apiKey, index) => {
                const pendingKey = `delete-provider-api-key:${apiKey.id}`
                const movePending = isPending(`move-provider-api-key:${apiKey.id}`)
                return <TableRow key={apiKey.id} className={apiKey.enabled ? undefined : "opacity-60"}>
                  <TableCell>
                    <div className="flex items-center gap-0.5">
                      <Button aria-label={`Move ${apiKey.name} up`} title="Move up" size="icon-xs" variant="ghost" disabled={index === 0 || movePending} onClick={() => void moveProviderApiKey(index, -1)}><ChevronUpIcon /></Button>
                      <Button aria-label={`Move ${apiKey.name} down`} title="Move down" size="icon-xs" variant="ghost" disabled={index === apiKeys.length - 1 || movePending} onClick={() => void moveProviderApiKey(index, 1)}><ChevronDownIcon /></Button>
                    </div>
                  </TableCell>
                  <TableCell className="font-medium">{apiKey.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{apiKey.rpmLimit ? `${apiKey.rpmLimit} rpm` : "—"}<span className="mx-2 text-border">·</span>{apiKey.maxConcurrency ? `${apiKey.maxConcurrency} concurrent` : "—"}</TableCell>
                  <TableCell><Badge variant={apiKey.enabled ? "secondary" : "outline"}>{apiKey.enabled ? "Enabled" : "Disabled"}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(apiKey.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell className="px-0"><div className="flex items-center justify-end gap-1"><Button aria-label={`Edit ${apiKey.name}`} size="icon-sm" variant="ghost" onClick={() => { setEditingProviderApiKey(apiKey); setProviderKeyOpen(true) }}><PencilIcon /></Button><ConfirmAction title={`Delete ${apiKey.name}?`} description="Requests currently routed through this key will fail." pending={isPending(pendingKey)} onConfirm={() => deleteProviderApiKey(apiKey)}><Trash2Icon /></ConfirmAction></div></TableCell>
                </TableRow>
              })}
              {!apiKeys.length && <EmptyRow label={provider.authType === "none" ? "This provider does not require API keys." : "No API keys yet."} colSpan={6} />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BoxesIcon className="size-5" />Models</CardTitle>
          <CardDescription>Expose upstream models behind your provider prefix.</CardDescription>
          <CardAction><Button onClick={() => { setEditingModel(null); setModelOpen(true) }}><PlusIcon />Add model</Button></CardAction>
        </CardHeader>
        <Dialog open={modelOpen} onOpenChange={(open) => { setModelOpen(open); if (!open) setEditingModel(null) }}>
          <DialogContent>
            <ModelForm key={editingModel?.id || "new"} provider={provider} model={editingModel} onSave={saveModel} />
          </DialogContent>
        </Dialog>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Gateway ID</TableHead>
                <TableHead>Upstream model</TableHead>
                <TableHead>Protocol</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((model) => {
                const pendingKey = `delete-model:${model.id}`
                const gatewayModelId = model.gatewayModelId || model.id
                return <TableRow key={model.id}>
                  <TableCell className="font-medium">{model.name}</TableCell>
                  <TableCell><div className="flex items-center justify-between gap-2"><div className="min-w-0 font-mono text-xs font-medium"><span className="break-all">{gatewayModelId}</span></div><Button aria-label={`Copy gateway ID ${gatewayModelId}`} size="icon-sm" variant="outline" className="shrink-0" onClick={() => { void navigator.clipboard.writeText(gatewayModelId); toast.success("Gateway ID copied") }}><CopyIcon /></Button></div></TableCell>
                  <TableCell>{model.upstreamModel}</TableCell>
                  <TableCell>{protocolLabels[model.protocol || provider.protocol]}{model.protocol && <Badge variant="outline" className="ml-2">override</Badge>}</TableCell>
                  <TableCell><div className="flex justify-end gap-1"><Button aria-label={`Edit ${model.name}`} size="icon-sm" variant="ghost" onClick={() => { setEditingModel(model); setModelOpen(true) }}><PencilIcon /></Button><ConfirmAction title={`Delete ${model.name}?`} description={`This permanently removes the ${model.name} mapping.`} pending={isPending(pendingKey)} onConfirm={() => deleteModel(model)}><Trash2Icon /></ConfirmAction></div></TableCell>
                </TableRow>
              })}
              {!models.length && <EmptyRow label="No models yet." colSpan={5} />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  </main>
}
