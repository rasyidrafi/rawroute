import { useState } from "react"
import { SearchIcon, Share2Icon } from "lucide-react"
import useSWR from "swr"
import { toast } from "sonner"

import { useDashboardApi } from "@rawroute/platform/web/api-context"
import { LoadingSpinner } from "@rawroute/ui/loading-spinner"
import { Button } from "@rawroute/ui/button"
import { Checkbox } from "@rawroute/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@rawroute/ui/dialog"
import { EmptyState } from "@rawroute/ui/empty-state"
import { Skeleton } from "@rawroute/ui/skeleton"
import { Switch } from "@rawroute/ui/switch"

type ShareTarget = { id: string; name: string; shared: boolean; onlyDuringUnlimited: boolean }
type ShareData = { targets: ShareTarget[] }

export function ModelShareButton({ modelId, modelName, disabled = false, onSaved }: { modelId: string; modelName: string; disabled?: boolean; onSaved?: () => Promise<unknown> | unknown }) {
  const { fetcher, apiPost } = useDashboardApi()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ShareTarget[] | null>(null)
  const [saving, setSaving] = useState(false)
  const { data, error, isLoading, mutate } = useSWR<ShareData>(`/api/admin/model-shares?modelId=${encodeURIComponent(modelId)}`, fetcher)
  const sharedTargets = new Map(data?.targets.filter(target => target.shared).map(target => [target.id, target]))
  const targets = draft || data?.targets || []
  const selectedIds = targets.filter(target => target.shared).map(target => target.id)
  const isShared = sharedTargets.size > 0

  async function save() {
    setSaving(true)
    try {
      await apiPost("/api/admin/model-shares", { modelId, recipientWorkspaceIds: selectedIds, unlimitedOnlyWorkspaceIds: targets.filter(target => target.shared && target.onlyDuringUnlimited).map(target => target.id) })
      await mutate()
      await onSaved?.()
      setOpen(false)
      toast.success("Model sharing updated")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update model sharing")
    } finally {
      setSaving(false)
    }
  }

  function openDialog() {
    setDraft(null)
    void mutate()
    setOpen(true)
  }

  function updateTarget(id: string, update: Partial<Pick<ShareTarget, "shared" | "onlyDuringUnlimited">>) {
    setDraft(current => (current || data?.targets || []).map(target => target.id === id ? { ...target, ...update } : target))
  }

  if (disabled && !isShared) return null
  return <>
    <Button size="sm" variant="outline" onClick={openDialog}><Share2Icon />{isShared ? "Manage Share" : "Share"}</Button>
    <Dialog open={open} onOpenChange={(next) => { if (!saving) setOpen(next) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isShared ? `Manage sharing: ${modelName}` : `Share ${modelName}`}</DialogTitle>
          <DialogDescription>Choose which workspaces can use this model.</DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-2 overflow-y-auto py-2">
          {error && <p role="alert" className="text-sm text-destructive">Unable to load available workspaces. {error.message}</p>}
          {isLoading
            ? Array.from({ length: 3 }).map((_, index) => <div key={index} className="flex items-center gap-3 rounded-lg border p-3"><Skeleton className="size-4" /><Skeleton className="h-5 w-40" /></div>)
            : data?.targets.length
              ? targets.map(target => <ShareTargetRow key={target.id} target={target} original={sharedTargets.get(target.id)} saving={saving} revokeOnly={disabled} update={updateTarget} />)
              : data && <EmptyState title="No other active workspaces" description="Model sharing requires at least one other active workspace." icon={SearchIcon} variant="compact" treatment="embedded" />}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>Cancel</Button>
          <Button aria-busy={saving} disabled={saving || isLoading || Boolean(error) || !data} onClick={() => void save()}>{saving && <LoadingSpinner />}Save sharing</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}

function ShareTargetRow({ target, original, saving, revokeOnly, update }: { target: ShareTarget; original?: ShareTarget; saving: boolean; revokeOnly: boolean; update: (id: string, patch: Partial<ShareTarget>) => void }) {
  return <div className="space-y-3 rounded-lg border p-3">
    <label className="flex cursor-pointer items-center gap-3"><Checkbox checked={target.shared} disabled={saving || (revokeOnly && !original)} onCheckedChange={checked => update(target.id, { shared: checked === true, onlyDuringUnlimited: checked === true && Boolean(original?.onlyDuringUnlimited) })} /><span className="text-sm font-medium">{target.name}</span></label>
    {target.shared && <label className="ml-7 flex cursor-pointer items-center justify-between gap-3 text-sm"><span>Only during Unlimited Mode<span className="sr-only"> for {target.name}</span></span><Switch title="Follows this workspace's Unlimited Mode" checked={target.onlyDuringUnlimited} disabled={saving || revokeOnly} onCheckedChange={checked => update(target.id, { onlyDuringUnlimited: checked })} /></label>}
  </div>
}
