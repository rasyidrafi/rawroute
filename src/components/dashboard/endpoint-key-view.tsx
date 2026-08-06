"use client"

import { useState } from "react"
import { CopyIcon, PencilIcon, PlusIcon, RouteIcon, Trash2Icon } from "lucide-react"
import useSWR from "swr"
import { toast } from "sonner"

import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { LoadingSpinner } from "@/components/loading-spinner"
import { ApiKeyForm } from "@/components/dashboard/api-key-form"
import { ConfirmAction, EndpointValue, maskApiKey } from "@/components/dashboard/shared"
import { apiDelete, apiPatch, apiPost } from "@/components/dashboard/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { ApiKey } from "@/lib/types"

type EndpointKeyResponse = { endpoint: string; apiKeys: ApiKey[] }

export function EndpointKeyView() {
  const { data, error, isLoading, isValidating, mutate } = useSWR<EndpointKeyResponse>("/api/admin/endpoint-key")
  const [keyOpen, setKeyOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null)
  const [editingName, setEditingName] = useState("")
  const [createdKey, setCreatedKey] = useState<string>()
  const [pending, setPending] = useState<Set<string>>(() => new Set())

  if (error) return <main className="grid min-h-[calc(100svh-var(--header-height))] place-items-center p-6 text-center"><div><p className="font-medium">Dashboard unavailable</p><p className="mt-2 text-sm text-muted-foreground">{error.message}</p><Button aria-busy={isValidating} className="mt-4" disabled={isValidating} onClick={() => void mutate()}>{isValidating && <LoadingSpinner />}Try again</Button></div></main>
  if (isLoading || !data) return <DashboardContentSkeleton variant="endpoint-key" />

  const isPending = (key: string) => pending.has(key)

  async function createKey(name: string, key?: string) {
    setPending((current) => new Set(current).add("create-api-key"))
    try {
      const response = await apiPost<{ apiKey: ApiKey }>("/api/admin/api-keys", { name, ...(key ? { key } : {}) })
      toast.success("API key created")
      setCreatedKey(response.apiKey.key)
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

  return <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
    <div className="mx-auto flex max-w-7xl flex-col gap-8">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><RouteIcon className="size-5" />API Endpoint</CardTitle>
          <CardDescription>Use this base URL with the native protocol endpoint supported by each model.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
            <Badge variant="secondary" className="shrink-0">Gateway</Badge>
            <EndpointValue />
            <Button aria-label="Copy API endpoint" size="icon-sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}/v1`); toast.success("Endpoint copied") }}><CopyIcon /></Button>
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
      <Dialog open={Boolean(editingKey)} onOpenChange={(open) => { if (!open) setEditingKey(null) }}><DialogContent><form onSubmit={(event) => { event.preventDefault(); void renameKey() }}><DialogHeader><DialogTitle>Edit API key name</DialogTitle><DialogDescription>The key value cannot be changed.</DialogDescription></DialogHeader><div className="py-5"><label htmlFor="gateway-api-key-name" className="text-sm font-medium">Key Name</label><Input id="gateway-api-key-name" value={editingName} onChange={(event) => setEditingName(event.target.value)} maxLength={80} autoFocus className="mt-2" /></div><DialogFooter><Button type="button" variant="outline" disabled={Boolean(editingKey && isPending(`rename-api-key:${editingKey.id}`))} onClick={() => setEditingKey(null)}>Cancel</Button><Button type="submit" aria-busy={Boolean(editingKey && isPending(`rename-api-key:${editingKey.id}`))} disabled={!editingName.trim() || Boolean(editingKey && isPending(`rename-api-key:${editingKey.id}`))}>{editingKey && isPending(`rename-api-key:${editingKey.id}`) && <LoadingSpinner />}Save name</Button></DialogFooter></form></DialogContent></Dialog>
      <Dialog open={Boolean(createdKey)} onOpenChange={(open) => { if (!open) setCreatedKey(undefined) }}><DialogContent><DialogHeader><DialogTitle>API key created</DialogTitle><DialogDescription>Copy this value now. It will only be available from the admin dashboard.</DialogDescription></DialogHeader><div className="flex items-center gap-2 py-5"><code className="min-w-0 flex-1 rounded-md border bg-muted/30 p-3 text-xs break-all">{createdKey}</code><Button aria-label="Copy created API key" size="icon-sm" variant="outline" onClick={() => { if (createdKey) { void navigator.clipboard.writeText(createdKey); toast.success("Copied") } }}><CopyIcon /></Button></div><DialogFooter><Button onClick={() => setCreatedKey(undefined)}>Done</Button></DialogFooter></DialogContent></Dialog>
        <CardContent className="space-y-3">
          {!data.apiKeys.length ? <div className="rounded-lg border border-dashed p-8 text-center"><p className="font-medium">No gateway API keys</p><p className="mt-1 text-sm text-muted-foreground">Create a key before sending requests through this workspace.</p></div> : null}
          {data.apiKeys.map((key) => {
            const pendingKey = `delete-api-key:${key.id}`
            return <div key={key.id} className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{key.name}</div>
                <code className="block truncate text-xs text-muted-foreground">{maskApiKey(key.key)}</code>
              </div>
              <Button aria-label={`Copy ${key.name}`} size="icon-sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(key.key); toast.success("Copied") }}><CopyIcon /></Button>
              <Button aria-label={`Edit ${key.name}`} size="icon-sm" variant="outline" onClick={() => { setEditingKey(key); setEditingName(key.name) }}><PencilIcon /></Button>
              <ConfirmAction title={`Delete ${key.name}?`} description="Clients using this key will immediately lose access." pending={isPending(pendingKey)} onConfirm={() => deleteKey(key)}><Trash2Icon /></ConfirmAction>
            </div>
          })}
        </CardContent>
      </Card>
    </div>
  </main>
}
