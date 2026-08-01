"use client"

import { useState, type FormEvent } from "react"

import { FormField, FormSubmitButton } from "@/components/dashboard/shared"
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Model, ModelAlias, Provider } from "@/lib/types"

export type AliasTargetOption = { id: string; providerName: string }

export function AliasForm({ alias, providers, models, onSave }: { alias: ModelAlias | null; providers: Provider[]; models: Model[]; onSave: (alias: Partial<ModelAlias> & { originalId?: string }) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  const [providerId, setProviderId] = useState<string | null>(() => {
    if (!alias) return null
    return models.find((model) => (model.gatewayModelId || model.id) === alias.targetModelId)?.providerId ?? null
  })
  const [targetModelId, setTargetModelId] = useState<string | null>(alias?.targetModelId ?? null)
  const providerModels = providerId
    ? models.filter((model) => model.providerId === providerId && model.enabled).sort((a, b) => (a.gatewayModelId || a.id).localeCompare(b.gatewayModelId || b.id, undefined, { sensitivity: "base" }))
    : []
  const selectedModelExists = !!targetModelId && providerModels.some((model) => (model.gatewayModelId || model.id) === targetModelId)
  const modelSelectValue = selectedModelExists ? targetModelId : null

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!providerId || !selectedModelExists) return
    const formData = new FormData(event.currentTarget)
    setPending(true)
    try {
      void onSave({
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
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Gateway ID"><Input name="alias" defaultValue={alias?.alias} placeholder="my-cool-model" pattern="[a-z0-9._-]+" title="Lowercase letters, numbers, dots, underscores and dashes" required /></FormField>
        <FormField label="Name"><Input name="name" defaultValue={alias?.name} placeholder="My Cool Model" maxLength={80} required /></FormField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Provider"><Select value={providerId} onValueChange={setProviderId} itemToStringLabel={(value) => providers.find((provider) => provider.id === value)?.name || String(value)}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent>{providers.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</SelectContent></Select></FormField>
        <FormField label="Model"><Select value={modelSelectValue} onValueChange={setTargetModelId} disabled={!providerId || providerModels.length === 0} itemToStringLabel={(value) => String(value)}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent>{providerModels.map((model) => <SelectItem key={model.id} value={model.gatewayModelId || model.id}><span className="font-mono">{model.gatewayModelId || model.id}</span><span className="ml-2 text-xs text-muted-foreground">{model.name}</span></SelectItem>)}</SelectContent></Select></FormField>
      </div>
      <input type="hidden" name="targetModelId" value={modelSelectValue || ""} />
    </div>
    <DialogFooter><FormSubmitButton pending={pending} idleLabel={alias ? "Save changes" : "Add alias"} pendingLabel="Saving…" /></DialogFooter>
  </form>
}
