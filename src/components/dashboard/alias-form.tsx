"use client"

import { useState, type FormEvent } from "react"

import { FormField, FormSubmitButton } from "@/components/dashboard/shared"
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ModelAlias } from "@/lib/types"

export type AliasTargetOption = { id: string; providerName: string }

export function AliasForm({ alias, targets, onSave }: { alias: ModelAlias | null; targets: AliasTargetOption[]; onSave: (alias: Partial<ModelAlias> & { originalId?: string }) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    setPending(true)
    try {
      await onSave({
        originalId: alias?.id,
        alias: String(formData.get("alias")),
        name: String(formData.get("name")),
        targetModelId: String(formData.get("targetModelId")),
      })
    } finally {
      setPending(false)
    }
  }
  return <form onSubmit={submit}>
    <DialogHeader><DialogTitle>{alias ? "Edit alias" : "Add alias"}</DialogTitle><DialogDescription>Create a custom model ID that forwards to an existing gateway model.</DialogDescription></DialogHeader>
    <div className="grid gap-4 py-4">
      <FormField label="Alias ID"><Input name="alias" defaultValue={alias?.alias} placeholder="my-cool-model" pattern="[a-z0-9._-]+" title="Lowercase letters, numbers, dots, underscores and dashes" required /></FormField>
      <FormField label="Name"><Input name="name" defaultValue={alias?.name} placeholder="My Cool Model" maxLength={80} required /></FormField>
      <FormField label="Target model"><Select name="targetModelId" defaultValue={alias?.targetModelId}><SelectTrigger className="h-9 w-full"><SelectValue placeholder="Choose a model" /></SelectTrigger><SelectContent>{targets.map((target) => <SelectItem key={target.id} value={target.id}><span className="font-mono">{target.id}</span><span className="ml-2 text-xs text-muted-foreground">{target.providerName}</span></SelectItem>)}</SelectContent></Select></FormField>
    </div>
    <DialogFooter><FormSubmitButton pending={pending} idleLabel={alias ? "Save changes" : "Add alias"} pendingLabel="Saving…" /></DialogFooter>
  </form>
}
