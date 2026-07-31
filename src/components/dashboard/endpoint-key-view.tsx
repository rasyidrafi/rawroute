"use client"

import { useState } from "react"
import { CopyIcon, PlusIcon, RouteIcon, Trash2Icon } from "lucide-react"
import useSWR from "swr"
import { toast } from "sonner"

import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { ApiKeyForm } from "@/components/dashboard/api-key-form"
import { ConfirmAction, EndpointValue, maskApiKey } from "@/components/dashboard/shared"
import { apiDelete, apiPost } from "@/components/dashboard/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import type { ApiKey } from "@/lib/types"

type EndpointKeyResponse = { endpoint: string; apiKeys: ApiKey[] }

export function EndpointKeyView() {
  const { data, error, isLoading, mutate } = useSWR<EndpointKeyResponse>("/api/admin/endpoint-key")
  const [keyOpen, setKeyOpen] = useState(false)
  const [pending, setPending] = useState<Set<string>>(() => new Set())

  if (error) return <main className="grid min-h-[calc(100svh-var(--header-height))] place-items-center p-6 text-center"><div><p className="font-medium">Dashboard unavailable</p><p className="mt-2 text-sm text-muted-foreground">{error.message}</p><Button className="mt-4" onClick={() => void mutate()}>Try again</Button></div></main>
  if (isLoading || !data) return <DashboardContentSkeleton />

  const isPending = (key: string) => pending.has(key)

  async function createKey(name: string) {
    setPending((current) => new Set(current).add("create-api-key"))
    try {
      await apiPost("/api/admin/api-keys", { name })
      toast.success("API key created")
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
        <CardContent className="space-y-3">
          {data.apiKeys.map((key) => {
            const pendingKey = `delete-api-key:${key.id}`
            return <div key={key.id} className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{key.name}</div>
                <code className="block truncate text-xs text-muted-foreground">{maskApiKey(key.key)}</code>
              </div>
              <Button aria-label={`Copy ${key.name}`} size="icon-sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(key.key); toast.success("Copied") }}><CopyIcon /></Button>
              <ConfirmAction title={`Delete ${key.name}?`} description="Clients using this key will immediately lose access." pending={isPending(pendingKey)} disabled={data.apiKeys.length === 1} onConfirm={() => deleteKey(key)}><Trash2Icon /></ConfirmAction>
            </div>
          })}
        </CardContent>
      </Card>
    </div>
  </main>
}