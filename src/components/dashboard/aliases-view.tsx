"use client"

import { useState } from "react"
import { ArrowLeftRightIcon, CopyIcon, PlusIcon, Trash2Icon } from "lucide-react"
import useSWR from "swr"
import { toast } from "sonner"

import { AliasForm, type AliasTargetOption } from "@/components/dashboard/alias-form"
import { apiDelete, apiPost } from "@/components/dashboard/api"
import { ConfirmAction, EmptyRow } from "@/components/dashboard/shared"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ModelAlias } from "@/lib/types"

type AliasesResponse = { aliases: ModelAlias[]; models: AliasTargetOption[] }

export function AliasesView() {
  const { data, error, isLoading, mutate } = useSWR<AliasesResponse>("/api/admin/aliases")
  const [aliasOpen, setAliasOpen] = useState(false)
  const [editingAlias, setEditingAlias] = useState<ModelAlias | null>(null)
  const [pending, setPending] = useState<Set<string>>(() => new Set())

  if (error) return <main className="grid min-h-[calc(100svh-var(--header-height))] place-items-center p-6 text-center"><div><p className="font-medium">Aliases unavailable</p><p className="mt-2 text-sm text-muted-foreground">{error.message}</p><Button className="mt-4" onClick={() => void mutate()}>Try again</Button></div></main>
  if (isLoading || !data) return <DashboardContentSkeleton variant="providers" />

  const isPending = (key: string) => pending.has(key)

  async function saveAlias(alias: Partial<ModelAlias> & { originalId?: string }) {
    setPending((current) => new Set(current).add("save-alias"))
    try {
      await apiPost("/api/admin/aliases", { alias })
      toast.success(editingAlias ? "Alias updated" : "Alias saved")
      await mutate()
      setAliasOpen(false)
      return true
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete("save-alias"); return next })
    }
  }

  async function deleteAlias(alias: ModelAlias) {
    const pendingKey = `delete-alias:${alias.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiDelete(`/api/admin/aliases/${alias.id}`)
      toast.success("Alias deleted")
      await mutate()
      return true
    } catch (deleteError) {
      toast.error(deleteError instanceof Error ? deleteError.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }

  return <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
    <div className="mx-auto flex max-w-7xl flex-col gap-8">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ArrowLeftRightIcon className="size-5" />Model Aliases</CardTitle>
          <CardDescription>Create custom model IDs that forward to any enabled gateway model.</CardDescription>
          <CardAction><Button onClick={() => { setEditingAlias(null); setAliasOpen(true) }}><PlusIcon />Add alias</Button></CardAction>
        </CardHeader>
        <Dialog open={aliasOpen} onOpenChange={(open) => { setAliasOpen(open); if (!open) setEditingAlias(null) }}>
          <DialogContent>
            <AliasForm key={editingAlias?.id || "new"} alias={editingAlias} targets={data.models} onSave={saveAlias} />
          </DialogContent>
        </Dialog>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Gateway ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Target model</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.aliases.map((alias) => {
                const pendingKey = `delete-alias:${alias.id}`
                return <TableRow key={alias.id}>
                  <TableCell><div className="flex items-center justify-between gap-2"><div className="min-w-0 font-mono text-xs font-medium"><span className="break-all">{alias.alias}</span></div><Button aria-label={`Copy gateway ID ${alias.alias}`} size="icon-sm" variant="outline" className="shrink-0" onClick={() => { void navigator.clipboard.writeText(alias.alias); toast.success("Gateway ID copied") }}><CopyIcon /></Button></div></TableCell>
                  <TableCell>{alias.name}</TableCell>
                  <TableCell>{alias.targetModelId}</TableCell>
                  <TableCell><div className="flex justify-end gap-1"><ConfirmAction title={`Delete ${alias.name || alias.alias}?`} description={`Requests using "${alias.alias}" will stop resolving. The target model is not affected.`} pending={isPending(pendingKey)} onConfirm={() => deleteAlias(alias)}><Trash2Icon /></ConfirmAction></div></TableCell>
                </TableRow>
              })}
              {!data.aliases.length && <EmptyRow label="No aliases yet." colSpan={4} />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  </main>
}
