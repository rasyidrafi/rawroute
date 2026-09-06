"use client"

import { useState } from "react"
import { ArrowLeftRightIcon, CopyIcon, ListOrderedIcon, PencilIcon, PlusIcon, Share2Icon, Trash2Icon } from "lucide-react"
import useSWR from "swr"
import { toast } from "sonner"

import { AliasForm } from "@/components/dashboard/alias-form"
import { ComboForm } from "@/components/dashboard/combo-form"
import { apiDelete, apiPost } from "@/components/dashboard/api"
import { ConfirmAction, EmptyRow } from "@/components/dashboard/shared"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { LoadingSpinner } from "@/components/loading-spinner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Model, ModelAlias, ModelCombo, Provider, SharedModelView } from "@/lib/types"

type RoutingResponse = { aliases: ModelAlias[]; combos: ModelCombo[]; models: Model[]; providers: Provider[]; sharedModels: SharedModelView[] }

export function AliasesView() {
  const { data, error, isLoading, isValidating, mutate } = useSWR<RoutingResponse>("/api/admin/aliases")
  const [aliasOpen, setAliasOpen] = useState(false)
  const [comboOpen, setComboOpen] = useState(false)
  const [editingAlias, setEditingAlias] = useState<ModelAlias | null>(null)
  const [editingCombo, setEditingCombo] = useState<ModelCombo | null>(null)
  const [pending, setPending] = useState<Set<string>>(() => new Set())

  if (error) return <main className="grid min-h-[calc(100svh-var(--header-height))] place-items-center p-6 text-center"><div><p className="font-medium">Model routing unavailable</p><p className="mt-2 text-sm text-muted-foreground">{error.message}</p><Button aria-busy={isValidating} className="mt-4" disabled={isValidating} onClick={() => void mutate()}>{isValidating && <LoadingSpinner />}Try again</Button></div></main>
  if (isLoading || !data) return <DashboardContentSkeleton variant="aliases" />

  const isPending = (key: string) => pending.has(key)
  const withPending = async (key: string, action: () => Promise<boolean>) => {
    setPending((current) => new Set(current).add(key))
    try { return await action() }
    finally { setPending((current) => { const next = new Set(current); next.delete(key); return next }) }
  }
  const saveAlias = (alias: Partial<ModelAlias> & { originalId?: string }) => withPending("save-alias", async () => {
    try { await apiPost("/api/admin/aliases", { alias }); toast.success(editingAlias?.id ? "Alias updated" : "Alias saved"); await mutate(); setAliasOpen(false); return true }
    catch (saveError) { toast.error(saveError instanceof Error ? saveError.message : "Request failed"); return false }
  })
  const saveCombo = (combo: Partial<ModelCombo> & { originalId?: string }) => withPending("save-combo", async () => {
    try { await apiPost("/api/admin/combos", { combo }); toast.success(editingCombo?.id ? "Combo updated" : "Combo saved"); await mutate(); setComboOpen(false); return true }
    catch (saveError) { toast.error(saveError instanceof Error ? saveError.message : "Request failed"); return false }
  })
  const deleteAlias = (alias: ModelAlias) => withPending(`delete-alias:${alias.id}`, async () => {
    try { await apiDelete(`/api/admin/aliases/${alias.id}`); toast.success("Alias deleted"); await mutate(); return true }
    catch (deleteError) { toast.error(deleteError instanceof Error ? deleteError.message : "Request failed"); return false }
  })
  const deleteCombo = (combo: ModelCombo) => withPending(`delete-combo:${combo.id}`, async () => {
    try { await apiDelete(`/api/admin/combos/${combo.id}`); toast.success("Combo deleted"); await mutate(); return true }
    catch (deleteError) { toast.error(deleteError instanceof Error ? deleteError.message : "Request failed"); return false }
  })
  const sharedById = new Map(data.sharedModels.map((model) => [model.id, model]))

  return <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8"><div className="mx-auto flex max-w-7xl flex-col gap-8">
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><ArrowLeftRightIcon className="size-5" />Aliases</CardTitle><CardDescription>Create local gateway IDs that forward to enabled local or shared models.</CardDescription><CardAction><Button onClick={() => { setEditingAlias(null); setAliasOpen(true) }}><PlusIcon />Add alias</Button></CardAction></CardHeader><Dialog open={aliasOpen} onOpenChange={(open) => { setAliasOpen(open); if (!open) setEditingAlias(null) }}><DialogContent><AliasForm key={editingAlias?.id || editingAlias?.sharedModelId || "new"} alias={editingAlias} providers={data.providers} models={data.models} sharedModels={data.sharedModels} onSave={saveAlias} /></DialogContent></Dialog><CardContent><Table><TableHeader><TableRow><TableHead>Gateway ID</TableHead><TableHead>Name</TableHead><TableHead>Target model</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader><TableBody>{data.aliases.map((alias) => { const shared = alias.sharedModelId ? sharedById.get(alias.sharedModelId) : undefined; const unavailable = Boolean(alias.sharedModelId && (!shared || shared.status !== "active")); return <TableRow key={alias.id}><TableCell><div className="flex items-center justify-between gap-2"><span className="min-w-0 break-all font-mono text-xs font-medium">{alias.alias}</span><Button aria-label={`Copy gateway ID ${alias.alias}`} size="icon-sm" variant="outline" className="shrink-0" onClick={() => { void navigator.clipboard.writeText(alias.alias); toast.success("Gateway ID copied") }}><CopyIcon /></Button></div></TableCell><TableCell>{alias.name}</TableCell><TableCell className="font-mono text-xs">{alias.targetModelId}</TableCell><TableCell>{alias.sharedModelId ? <Badge variant={unavailable ? "destructive" : "secondary"}>{unavailable ? "Unavailable" : "Shared"}</Badge> : <Badge variant="outline">Local</Badge>}</TableCell><TableCell><div className="flex justify-end gap-1"><Button aria-label={`Edit ${alias.name || alias.alias}`} size="icon-sm" variant="ghost" onClick={() => { setEditingAlias(alias); setAliasOpen(true) }}><PencilIcon /></Button><ConfirmAction title={`Delete ${alias.name || alias.alias}?`} description={`Requests using "${alias.alias}" will stop resolving. The target model is not affected.`} pending={isPending(`delete-alias:${alias.id}`)} onConfirm={() => deleteAlias(alias)}><Trash2Icon /></ConfirmAction></div></TableCell></TableRow> })}{!data.aliases.length && <EmptyRow label="No aliases yet." colSpan={5} />}</TableBody></Table></CardContent></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><ListOrderedIcon className="size-5" />Combos</CardTitle><CardDescription>Try models in order until one accepts the request.</CardDescription><CardAction><Button onClick={() => { setEditingCombo(null); setComboOpen(true) }}><PlusIcon />Add combo</Button></CardAction></CardHeader><Dialog open={comboOpen} onOpenChange={(open) => { setComboOpen(open); if (!open) setEditingCombo(null) }}><DialogContent><ComboForm key={editingCombo?.id || "new"} combo={editingCombo} models={data.models} aliases={data.aliases} sharedModels={data.sharedModels} onSave={saveCombo} /></DialogContent></Dialog><CardContent><Table><TableHeader><TableRow><TableHead>Gateway ID</TableHead><TableHead>Name</TableHead><TableHead>Fallback order</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader><TableBody>{data.combos.map((combo) => <TableRow key={combo.id}><TableCell><div className="flex items-center justify-between gap-2"><span className="min-w-0 break-all font-mono text-xs font-medium">{combo.combo}</span><Button aria-label={`Copy gateway ID ${combo.combo}`} size="icon-sm" variant="outline" className="shrink-0" onClick={() => { void navigator.clipboard.writeText(combo.combo); toast.success("Gateway ID copied") }}><CopyIcon /></Button></div></TableCell><TableCell>{combo.name}</TableCell><TableCell><ol className="space-y-1 font-mono text-xs">{combo.memberModelIds.map((member) => <li key={member}>{member}</li>)}</ol></TableCell><TableCell><div className="flex justify-end gap-1"><Button aria-label={`Edit ${combo.name || combo.combo}`} size="icon-sm" variant="ghost" onClick={() => { setEditingCombo(combo); setComboOpen(true) }}><PencilIcon /></Button><ConfirmAction title={`Delete ${combo.name || combo.combo}?`} description={`Requests using "${combo.combo}" will stop resolving. The member models are not affected.`} pending={isPending(`delete-combo:${combo.id}`)} onConfirm={() => deleteCombo(combo)}><Trash2Icon /></ConfirmAction></div></TableCell></TableRow>)}{!data.combos.length && <EmptyRow label="No combos yet." colSpan={4} />}</TableBody></Table></CardContent></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Share2Icon className="size-5" />Shared Models</CardTitle><CardDescription>Read-only models shared into this workspace. Create a local alias before gateway keys can use one.</CardDescription></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Qualified model</TableHead><TableHead>Source workspace</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader><TableBody>{data.sharedModels.map((model) => <TableRow key={model.id}><TableCell><div className="font-mono text-xs">{model.qualifiedModelId}</div><div className="mt-1 text-sm">{model.sourceModelName}</div></TableCell><TableCell>{model.ownerWorkspaceName}</TableCell><TableCell><Badge variant={model.status === "active" ? "secondary" : "destructive"}>{model.status === "active" ? "Available" : model.status === "revoked" ? "Revoked" : "Unavailable"}</Badge></TableCell><TableCell className="text-right"><Button size="sm" variant="outline" disabled={model.status !== "active"} onClick={() => { setEditingAlias({ id: "", alias: "", name: model.sourceModelName, targetModelId: model.qualifiedModelId, sharedModelId: model.id, createdAt: new Date().toISOString() }); setAliasOpen(true) }}><PlusIcon />Create alias</Button></TableCell></TableRow>)}{!data.sharedModels.length && <EmptyRow label="No models have been shared with this workspace." colSpan={4} />}</TableBody></Table></CardContent></Card>
  </div></main>
}
