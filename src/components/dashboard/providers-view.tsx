"use client"

import { useState } from "react"
import { ChevronRightIcon, PlusIcon, Trash2Icon } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"

import { ConfirmAction, EmptyRow } from "@/components/dashboard/shared"
import { ProviderForm } from "@/components/dashboard/provider-form"
import { apiDelete, apiPost } from "@/components/dashboard/api"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { protocolLabels, type Provider, type ProviderSummary } from "@/lib/types"

type ProvidersResponse = { providers: ProviderSummary[] }

export function ProvidersView() {
  const router = useRouter()
  const { data, error, isLoading, mutate } = useSWR<ProvidersResponse>("/api/admin/providers")
  const [providerOpen, setProviderOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [pending, setPending] = useState<Set<string>>(() => new Set())

  if (error) return <main className="grid min-h-[calc(100svh-var(--header-height))] place-items-center p-6 text-center"><div><p className="font-medium">Dashboard unavailable</p><p className="mt-2 text-sm text-muted-foreground">{error.message}</p><Button className="mt-4" onClick={() => void mutate()}>Try again</Button></div></main>
  if (isLoading || !data) return <DashboardContentSkeleton variant="providers" />

  const isPending = (key: string) => pending.has(key)

  async function saveProvider(provider: Partial<Provider> & { originalId?: string }) {
    setPending((current) => new Set(current).add("save-provider"))
    try {
      await apiPost("/api/admin/providers", { provider })
      toast.success(editingProvider ? "Provider updated" : "Provider saved")
      await mutate()
      setProviderOpen(false)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete("save-provider"); return next })
    }
  }

  async function deleteProvider(provider: ProviderSummary) {
    const pendingKey = `delete-provider:${provider.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiDelete(`/api/admin/providers/${provider.id}`)
      toast.success("Provider deleted")
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
          <CardTitle>Providers</CardTitle>
          <CardDescription>Choose a provider to manage its connection settings and upstream API keys.</CardDescription>
          <CardAction><Button onClick={() => { setEditingProvider(null); setProviderOpen(true) }}><PlusIcon />Add provider</Button></CardAction>
        </CardHeader>
        <Dialog open={providerOpen} onOpenChange={(open) => { setProviderOpen(open); if (!open) setEditingProvider(null) }}>
          <DialogContent>
            <ProviderForm key={editingProvider?.id || "new"} provider={editingProvider} onSave={saveProvider} />
          </DialogContent>
        </Dialog>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Protocol</TableHead>
                <TableHead>Origin</TableHead>
                <TableHead>API keys</TableHead>
                <TableHead>Models</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.providers.map((provider) => {
                const pendingKey = `delete-provider:${provider.id}`
                return <TableRow key={provider.id} className="cursor-pointer" onClick={() => router.push(`/dashboard/providers/${provider.id}`)}>
                  <TableCell><Link href={`/dashboard/providers/${provider.id}`} prefetch={false} className="font-medium hover:underline" onClick={(event) => event.stopPropagation()}>{provider.name}</Link></TableCell>
                  <TableCell><Badge variant="secondary">{provider.prefix}/</Badge></TableCell>
                  <TableCell>{protocolLabels[provider.protocol]}</TableCell>
                  <TableCell className="max-w-64 truncate font-mono text-xs">{provider.baseUrl}</TableCell>
                  <TableCell><div className="flex items-center gap-2"><span className="font-medium tabular-nums">{provider.apiKeyCount}</span><span className="text-xs text-muted-foreground">configured</span>{provider.authType !== "none" && provider.enabledApiKeyCount !== provider.apiKeyCount && <Badge variant="outline">{provider.enabledApiKeyCount} enabled</Badge>}</div></TableCell>
                  <TableCell><div className="flex items-center gap-2"><span className="font-medium tabular-nums">{provider.modelCount}</span><span className="text-xs text-muted-foreground">configured</span>{provider.enabledModelCount !== provider.modelCount && <Badge variant="outline">{provider.enabledModelCount} enabled</Badge>}</div></TableCell>
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      {provider.prefix !== "codex" && <ConfirmAction title={`Delete ${provider.name}?`} description={`This permanently deletes ${provider.apiKeyCount} API keys and ${provider.modelCount} models attached to this provider.`} pending={isPending(pendingKey)} onConfirm={() => deleteProvider(provider)}><Trash2Icon /></ConfirmAction>}
                      <Button nativeButton={false} aria-label={`Open ${provider.name}`} size="icon-sm" variant="ghost" render={<Link href={`/dashboard/providers/${provider.id}`} prefetch={false} />}><ChevronRightIcon /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              })}
              {!data.providers.length && <EmptyRow label="No providers yet." colSpan={7} />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  </main>
}
