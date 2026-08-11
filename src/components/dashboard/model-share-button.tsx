"use client"

import { useState } from "react"
import useSWR from "swr"
import { Share2Icon } from "lucide-react"
import { toast } from "sonner"

import { apiPost, fetcher } from "@/components/dashboard/api"
import { LoadingSpinner } from "@/components/loading-spinner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"

type ShareData = { targets: Array<{ id: string; name: string; shared: boolean }> }

export function ModelShareButton({ modelId, modelName, disabled = false, onSaved }: { modelId: string; modelName: string; disabled?: boolean; onSaved?: () => Promise<unknown> | unknown }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[] | null>(null)
  const [saving, setSaving] = useState(false)
  const { data, isLoading } = useSWR<ShareData>(`/api/admin/model-shares?modelId=${encodeURIComponent(modelId)}`, fetcher)
  const selectedIds = selected || data?.targets.filter((target) => target.shared).map((target) => target.id) || []
  const sharedCount = data?.targets.filter((target) => target.shared).length
  async function save() {
    setSaving(true)
    try {
      await apiPost("/api/admin/model-shares", { modelId, recipientWorkspaceIds: selectedIds })
      await onSaved?.()
      setOpen(false)
      toast.success("Model sharing updated")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update model sharing")
    } finally { setSaving(false) }
  }
  return <><Button size="sm" variant="outline" disabled={disabled} onClick={() => { setSelected(null); setOpen(true) }}><Share2Icon />{sharedCount ? `Shared to ${sharedCount}` : "Share"}</Button><Dialog open={open} onOpenChange={(next) => { if (!saving) setOpen(next) }}><DialogContent><DialogHeader><DialogTitle>Share {modelName}</DialogTitle><DialogDescription>Grant another workspace access to this model. Provider credentials, pricing, and billing remain in this workspace.</DialogDescription></DialogHeader><div className="max-h-72 space-y-2 overflow-y-auto py-2">{isLoading ? Array.from({ length: 3 }).map((_, index) => <div key={index} className="flex items-center gap-3 rounded-lg border p-3"><Skeleton className="size-4" /><Skeleton className="h-4 w-40" /></div>) : data?.targets.length ? data.targets.map((target) => <label key={target.id} className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 hover:bg-muted"><Checkbox checked={selectedIds.includes(target.id)} disabled={saving} onCheckedChange={() => setSelected((current) => { const next = current || selectedIds; return next.includes(target.id) ? next.filter((id) => id !== target.id) : [...next, target.id] })} /><span className="text-sm font-medium">{target.name}</span></label>) : <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No other active workspaces are available.</p>}</div><DialogFooter><Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>Cancel</Button><Button aria-busy={saving} disabled={saving || isLoading} onClick={() => void save()}>{saving && <LoadingSpinner />}Save sharing</Button></DialogFooter></DialogContent></Dialog></>
}
