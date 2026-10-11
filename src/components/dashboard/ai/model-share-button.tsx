import { useState } from "react"
import { SearchIcon, Share2Icon } from "lucide-react"
import useSWR from "swr"
import { toast } from "sonner"

import { useDashboardApi } from "@/components/dashboard/api-context"
import { LoadingSpinner } from "@/components/loading-spinner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"

type ShareTarget = { id: string; name: string; shared: boolean }
type ShareData = { targets: ShareTarget[] }

export function ModelShareButton({ modelId, modelName, disabled = false, onSaved }: { modelId: string; modelName: string; disabled?: boolean; onSaved?: () => Promise<unknown> | unknown }) {
  const { fetcher, apiPost } = useDashboardApi()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[] | null>(null)
  const [saving, setSaving] = useState(false)
  const { data, error, isLoading, mutate } = useSWR<ShareData>(`/api/admin/model-shares?modelId=${encodeURIComponent(modelId)}`, fetcher)
  const sharedTargetIds = data?.targets.filter((target) => target.shared).map((target) => target.id) || []
  const selectedIds = selected || sharedTargetIds
  const selectedIdSet = new Set(selectedIds)
  const isShared = sharedTargetIds.length > 0

  async function save() {
    setSaving(true)
    try {
      await apiPost("/api/admin/model-shares", { modelId, recipientWorkspaceIds: selectedIds })
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
    setSelected(null)
    void mutate()
    setOpen(true)
  }

  return <>
    <Button size="sm" variant="outline" disabled={disabled} onClick={openDialog}><Share2Icon />{isShared ? "Manage Share" : "Share"}</Button>
    <Dialog open={open} onOpenChange={(next) => { if (!saving) setOpen(next) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isShared ? `Manage sharing: ${modelName}` : `Share ${modelName}`}</DialogTitle>
          <DialogDescription>Grant another workspace access to this model. Provider credentials, pricing, and billing remain in this workspace.</DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-2 overflow-y-auto py-2">
          {error && <p role="alert" className="text-sm text-destructive">Unable to load available workspaces. {error.message}</p>}
          {isLoading
            ? Array.from({ length: 3 }).map((_, index) => <div key={index} className="flex items-center gap-3 rounded-lg border p-3"><Skeleton className="size-4" /><Skeleton className="h-5 w-40" /></div>)
            : data?.targets.length
              ? data.targets.map((target) => <label key={target.id} className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 hover:bg-muted"><Checkbox checked={selectedIdSet.has(target.id)} disabled={saving} onCheckedChange={() => setSelected((current) => { const next = current || selectedIds; return next.includes(target.id) ? next.filter((id) => id !== target.id) : [...next, target.id] })} /><span className="text-sm font-medium">{target.name}</span></label>)
              : data && <EmptyState title="No other active workspaces" description="Model sharing requires at least one other active workspace." icon={SearchIcon} variant="compact" treatment="embedded" />}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>Cancel</Button>
          <Button aria-busy={saving} disabled={saving || isLoading} onClick={() => void save()}>{saving && <LoadingSpinner />}Save sharing</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
