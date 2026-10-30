import { DashboardPage } from "@rawroute/ui/page-layout"
import { useDashboardClipboard } from "@rawroute/platform/web/use-dashboard-clipboard"
import { useState } from "react"
import { CopyIcon, KeyRoundIcon, PencilIcon, PlusIcon, RefreshCwIcon, RouteIcon, Trash2Icon } from "lucide-react"
import useSWR from "swr"
import { toast } from "sonner"

import { AiContentSkeleton as DashboardContentSkeleton } from "../skeletons"
import { LoadingSpinner } from "@rawroute/ui/loading-spinner"
import { ApiKeyForm } from "./api-key-form"
import { LoadError, ConfirmAction } from "@rawroute/ui/resource-feedback"
import { EndpointValue, maskApiKey } from "../endpoint-display"
import { useDashboardApi } from "@rawroute/platform/web/api-context"
import { Badge } from "@rawroute/ui/badge"
import { Button } from "@rawroute/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@rawroute/ui/dialog"
import { EmptyState } from "@rawroute/ui/empty-state"
import { Input } from "@rawroute/ui/input"
import type { ApiKey } from "../../contracts/domain"

type EndpointKeyResponse = { endpoint: string; apiKeys: ApiKey[] }

export function EndpointKeyView() {
  const copy = useDashboardClipboard()
  const { apiPost, apiDelete, apiPatch } = useDashboardApi()
  const { data, error, isLoading, isValidating, mutate } = useSWR<EndpointKeyResponse>("/api/admin/endpoint-key")
  const [keyOpen, setKeyOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null)
  const [editingName, setEditingName] = useState("")
  const [rotatingKey, setRotatingKey] = useState<ApiKey | null>(null)
  const [revealedKey, setRevealedKey] = useState<{ value: string; title: string; description: string }>()
  const [pending, setPending] = useState<Set<string>>(() => new Set())

  if (error) return <LoadError title="Dashboard unavailable" error={error} retrying={isValidating} onRetry={() => void mutate()} />
  if (isLoading || !data) return <DashboardContentSkeleton variant="endpoint-key" />

  const isPending = (key: string) => pending.has(key)

  async function createKey(name: string, key?: string) {
    setPending((current) => new Set(current).add("create-api-key"))
    try {
      const response = await apiPost<{ apiKey: ApiKey }>("/api/admin/api-keys", { name, ...(key ? { key } : {}) })
      toast.success("API key created")
      setRevealedKey({ value: response.apiKey.key, title: "API key created", description: "Copy this value now. It will only be available from the admin dashboard." })
      await mutate()
      setKeyOpen(false)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete("create-api-key"); return next })
    }
  }

  async function rotateKey(apiKey: ApiKey, key?: string) {
    const pendingKey = `rotate-api-key:${apiKey.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      const response = await apiPost<{ apiKey: ApiKey }>(`/api/admin/api-keys/${apiKey.id}/rotate`, key ? { key } : {})
      toast.success("API key replaced")
      setRevealedKey({ value: response.apiKey.key, title: "API key replaced", description: "Copy this replacement now. The previous token no longer works for new requests, and this value will only be available from the admin dashboard." })
      await mutate()
      setRotatingKey(null)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }

  async function deleteKey(apiKey: ApiKey) {
    const pendingKey = `delete-api-key:${apiKey.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiDelete(`/api/admin/api-keys/${apiKey.id}`)
      toast.success("API key deleted")
      await mutate()
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }

  async function renameKey() {
    if (!editingKey) return false
    const pendingKey = `rename-api-key:${editingKey.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiPatch(`/api/admin/api-keys/${editingKey.id}`, { name: editingName.trim() })
      toast.success("API key name updated")
      await mutate()
      setEditingKey(null)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }

  return <DashboardPage>
      <Card>
        <CardHeader>
          <CardTitle variant="icon"><RouteIcon className="size-5" />API Endpoint</CardTitle>
          <CardDescription>Use this base URL with the native protocol endpoint supported by each model.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
            <Badge variant="secondary" className="shrink-0">Gateway</Badge>
            <EndpointValue />
            <Button aria-label="Copy API endpoint" size="icon-sm" variant="outline" onClick={() => { void copy(`${window.location.origin}/v1`, "Endpoint copied") }}><CopyIcon /></Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Gateway API keys</CardTitle>
          <CardDescription>Clients use these keys to access every proxy endpoint.</CardDescription>
          <CardAction><Button onClick={() => setKeyOpen(true)}><PlusIcon />Create key</Button></CardAction>
        </CardHeader>
      <Dialog open={keyOpen} onOpenChange={setKeyOpen}><DialogContent><ApiKeyForm onSave={createKey} /></DialogContent></Dialog>
      <Dialog open={Boolean(rotatingKey)} onOpenChange={(open) => { if (!open) setRotatingKey(null) }}><DialogContent>{rotatingKey && <ApiKeyForm key={rotatingKey.id} name={rotatingKey.name} onSave={(_name, key) => rotateKey(rotatingKey, key)} />}</DialogContent></Dialog>
      <Dialog open={Boolean(editingKey)} onOpenChange={(open) => { if (!open) setEditingKey(null) }}><DialogContent><form onSubmit={(event) => { event.preventDefault(); void renameKey() }}><DialogHeader><DialogTitle>Edit API key name</DialogTitle><DialogDescription>The key value cannot be changed.</DialogDescription></DialogHeader><div className="py-5"><label htmlFor="gateway-api-key-name" className="text-sm font-medium">Key Name</label><Input id="gateway-api-key-name" value={editingName} onChange={(event) => setEditingName(event.target.value)} maxLength={80} autoFocus className="mt-2" /></div><DialogFooter><Button type="button" variant="outline" disabled={Boolean(editingKey && isPending(`rename-api-key:${editingKey.id}`))} onClick={() => setEditingKey(null)}>Cancel</Button><Button type="submit" aria-busy={Boolean(editingKey && isPending(`rename-api-key:${editingKey.id}`))} disabled={!editingName.trim() || Boolean(editingKey && isPending(`rename-api-key:${editingKey.id}`))}>{editingKey && isPending(`rename-api-key:${editingKey.id}`) && <LoadingSpinner />}Save name</Button></DialogFooter></form></DialogContent></Dialog>
      <Dialog open={Boolean(revealedKey)} onOpenChange={(open) => { if (!open) setRevealedKey(undefined) }}><DialogContent><DialogHeader><DialogTitle>{revealedKey?.title}</DialogTitle><DialogDescription>{revealedKey?.description}</DialogDescription></DialogHeader><div className="flex items-center gap-2 py-5"><code className="min-w-0 flex-1 rounded-md border bg-muted/30 p-3 text-xs break-all">{revealedKey?.value}</code><Button aria-label="Copy revealed API key" size="icon-sm" variant="outline" onClick={() => { if (revealedKey) { void copy(revealedKey.value, "Copied") } }}><CopyIcon /></Button></div><DialogFooter><Button onClick={() => setRevealedKey(undefined)}>Done</Button></DialogFooter></DialogContent></Dialog>
        <CardContent spacing="compact-stack">
          {!data.apiKeys.length && <EmptyState title="No gateway API keys" description="Create a key before sending requests through this workspace." icon={KeyRoundIcon} variant="compact" treatment="embedded" />}
          {data.apiKeys.map((key) => {
            const pendingKey = `delete-api-key:${key.id}`
            return <div key={key.id} className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{key.name}</div>
                <code className="block truncate text-xs text-muted-foreground">{maskApiKey(key.key)}</code>
              </div>
              <Button aria-label={`Copy ${key.name}`} size="icon-sm" variant="outline" onClick={() => { void copy(key.key, "Copied") }}><CopyIcon /></Button>
              <Button aria-label={`Edit ${key.name}`} size="icon-sm" variant="outline" onClick={() => { setEditingKey(key); setEditingName(key.name) }}><PencilIcon /></Button>
              <Button aria-label={`Rotate ${key.name}`} size="icon-sm" variant="outline" disabled={isPending(`rotate-api-key:${key.id}`)} onClick={() => setRotatingKey(key)}><RefreshCwIcon /></Button>
              <ConfirmAction title={`Delete ${key.name}?`} description="Clients using this key will immediately lose access." pending={isPending(pendingKey)} onConfirm={() => deleteKey(key)}><Trash2Icon /></ConfirmAction>
            </div>
          })}
        </CardContent>
      </Card>
    </DashboardPage>
}
