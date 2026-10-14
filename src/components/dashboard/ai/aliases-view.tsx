import { useState } from "react"
import { CopyIcon, ListOrderedIcon, PencilIcon, PlusIcon, Share2Icon, Trash2Icon } from "lucide-react"
import useSWR from "swr"
import { toast } from "sonner"

import { ComboForm } from "@/components/dashboard/ai/combo-form"
import { ApiRequestError } from "@/components/dashboard/api"
import { useDashboardApi } from "@/components/dashboard/api-context"
import { DashboardPage } from "@/components/dashboard/page-layout"
import { LoadError, ConfirmAction, EmptyRow } from "@/components/dashboard/shared"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { TableColumns, Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import { useDashboardClipboard } from "@/hooks/use-dashboard-clipboard"
import { comboMembers } from "@/lib/combo-reasoning"
import type { Model, ModelCombo, SharedModelView } from "@/lib/types"

type RoutingResponse = { combos: ModelCombo[]; models: Model[]; sharedModels: SharedModelView[] }

export function AliasesView() {
  const copy = useDashboardClipboard()
  const { apiPost, apiDelete } = useDashboardApi()
  const { data, error, isLoading, isValidating, mutate } = useSWR<RoutingResponse>("/api/admin/combos")
  const [comboOpen, setComboOpen] = useState(false)
  const [editingCombo, setEditingCombo] = useState<ModelCombo | null>(null)
  const [pending, setPending] = useState<Set<string>>(() => new Set())

  if (error) return <LoadError title="Model routing unavailable" error={error} retrying={isValidating} onRetry={() => void mutate()} />
  if (isLoading || !data) return <DashboardContentSkeleton variant="aliases" />

  const withPending = async (key: string, action: () => Promise<boolean>) => {
    setPending((current) => new Set(current).add(key))
    try { return await action() }
    finally { setPending((current) => { const next = new Set(current); next.delete(key); return next }) }
  }
  const saveCombo = (combo: Partial<ModelCombo> & { originalId?: string }) => withPending("save-combo", async () => {
    try {
      await apiPost("/api/admin/combos", { combo })
      toast.success(editingCombo?.id ? "Combo updated" : "Combo saved")
      await mutate(); setComboOpen(false); return true
    } catch (saveError) {
      const details = saveError instanceof ApiRequestError ? saveError.details as { confirmationToken?: string; results?: Array<{ modelId: string; message: string }> } | undefined : undefined
      if (saveError instanceof ApiRequestError && saveError.status === 409 && details?.confirmationToken) {
        const summary = details.results?.map((result) => `${result.modelId}: ${result.message}`).join("\n") || saveError.message
        if (window.confirm(`${summary}\n\nSave this combo as unverified?`)) {
          try {
            await apiPost("/api/admin/combos", { combo, confirmationToken: details.confirmationToken })
            toast.success(editingCombo?.id ? "Combo updated as unverified" : "Combo saved as unverified")
            await mutate(); setComboOpen(false); return true
          } catch (retryError) { toast.error(retryError instanceof Error ? retryError.message : "Request failed"); return false }
        }
      }
      toast.error(saveError instanceof Error ? saveError.message : "Request failed"); return false
    }
  })
  const deleteCombo = (combo: ModelCombo) => withPending(`delete-combo:${combo.id}`, async () => {
    try { await apiDelete(`/api/admin/combos/${combo.id}`); toast.success("Combo deleted"); await mutate(); return true }
    catch (deleteError) { toast.error(deleteError instanceof Error ? deleteError.message : "Request failed"); return false }
  })
  const editCombo = (combo: ModelCombo | null) => { setEditingCombo(combo); setComboOpen(true) }
  const sharedById = new Map(data.sharedModels.map((model) => [model.id, model]))

  return <DashboardPage>
    <Card>
      <CardHeader>
        <CardTitle variant="icon"><ListOrderedIcon />Combos</CardTitle>
        <CardDescription>Select one model to create an alias, or multiple models to try in fallback order.</CardDescription>
        <CardAction><Button onClick={() => editCombo(null)}><PlusIcon />Add combo</Button></CardAction>
      </CardHeader>
      <Dialog open={comboOpen} onOpenChange={(open) => { setComboOpen(open); if (!open) setEditingCombo(null) }}>
        <DialogContent className="sm:max-w-3xl"><ComboForm key={editingCombo?.id || editingCombo?.members[0]?.modelId || "new"} combo={editingCombo} models={data.models} sharedModels={data.sharedModels} onSave={saveCombo} /></DialogContent>
      </Dialog>
      <CardContent><Table>
        <TableColumns columns={[{ id: "Gateway ID", label: "Gateway ID" }, { id: "Name", label: "Name" }, { id: "Models", label: "Models / fallback order" }, { id: "Actions", label: "Actions", className: "text-right" }]} />
        <TableBody>{data.combos.map((combo) => {
          const members = comboMembers(combo)
          const visibleMembers = members.slice(0, 3)
          const hiddenCount = members.length - visibleMembers.length
          return <TableRow key={combo.id}>
            <TableCell><div className="flex items-center justify-between gap-2"><span className="min-w-0 break-all font-mono text-xs font-medium">{combo.combo}</span><Button aria-label={`Copy gateway ID ${combo.combo}`} size="icon-sm" variant="outline" className="shrink-0" onClick={() => { void copy(combo.combo, "Gateway ID copied") }}><CopyIcon /></Button></div></TableCell>
            <TableCell>{combo.name}</TableCell>
            <TableCell><ol className="flex flex-col gap-1 text-xs">{visibleMembers.map((member, index) => <li key={member.modelId} className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono">{member.modelId}</span>
              {member.sharedModelId && <Badge variant={sharedById.get(member.sharedModelId)?.status === "active" ? "secondary" : "destructive"}>{sharedById.get(member.sharedModelId)?.status === "active" ? "Shared" : "Unavailable"}</Badge>}
              {member.reasoning?.mode === "override" && <Badge variant="outline">{member.reasoning.effort}</Badge>}
              {member.customPayload && <Badge variant="outline">Custom</Badge>}
              {member.validation?.status && (member.reasoning?.mode === "override" || member.customPayload) && <span className="shrink-0 text-muted-foreground">{member.validation.status}</span>}
              {index === visibleMembers.length - 1 && hiddenCount > 0 && <Badge variant="secondary">+{hiddenCount} more</Badge>}
            </li>)}</ol></TableCell>
            <TableCell><div className="flex justify-end gap-1"><Button aria-label={`Edit ${combo.name || combo.combo}`} size="icon-sm" variant="ghost" onClick={() => editCombo(combo)}><PencilIcon /></Button><ConfirmAction title={`Delete ${combo.name || combo.combo}?`} description={`Requests using "${combo.combo}" will stop resolving. The member models are not affected.`} pending={pending.has(`delete-combo:${combo.id}`)} onConfirm={() => deleteCombo(combo)}><Trash2Icon /></ConfirmAction></div></TableCell>
          </TableRow>
        })}{!data.combos.length && <EmptyRow label="No combos yet. Add one model for an alias, or multiple models for fallback." colSpan={4} />}</TableBody>
      </Table></CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle variant="icon"><Share2Icon />Shared Models</CardTitle><CardDescription>Read-only models shared into this workspace. Add one to a combo to give it a local gateway ID.</CardDescription></CardHeader>
      <CardContent><Table>
        <TableColumns columns={[{ id: "Qualified model", label: "Qualified model" }, { id: "Source workspace", label: "Source workspace" }, { id: "Status", label: "Status" }, { id: "Action", label: "Action", className: "text-right" }]} />
        <TableBody>{data.sharedModels.map((model) => <TableRow key={model.id}>
          <TableCell><div className="font-mono text-xs">{model.qualifiedModelId}</div><div className="mt-1 text-sm">{model.sourceModelName}</div></TableCell>
          <TableCell>{model.ownerWorkspaceName}</TableCell>
          <TableCell><Badge variant={model.status === "active" ? "secondary" : "destructive"}>{model.status === "active" ? "Available" : model.status === "revoked" ? "Revoked" : "Unavailable"}</Badge></TableCell>
          <TableCell className="text-right"><Button size="sm" variant="outline" disabled={model.status !== "active"} onClick={() => editCombo({ id: "", combo: "", name: model.sourceModelName, members: [{ modelId: model.qualifiedModelId, sharedModelId: model.id }], createdAt: "" })}><PlusIcon />Create combo</Button></TableCell>
        </TableRow>)}{!data.sharedModels.length && <EmptyRow label="No models have been shared with this workspace." colSpan={4} />}</TableBody>
      </Table></CardContent>
    </Card>
  </DashboardPage>
}
