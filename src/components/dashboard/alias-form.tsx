"use client"

import { useMemo, useState, type FormEvent } from "react"

import { FormField, FormSubmitButton } from "@/components/dashboard/shared"
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Model, ModelAlias, Provider, SharedModelView } from "@/lib/types"

const SHARED_PROVIDER_ID = "__shared_models__"

export function AliasForm({ alias, providers, models, sharedModels = [], onSave }: { alias: ModelAlias | null; providers: Provider[]; models: Model[]; sharedModels?: SharedModelView[]; onSave: (alias: Partial<ModelAlias> & { originalId?: string }) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  const [providerId, setProviderId] = useState<string | null>(() => alias?.sharedModelId ? SHARED_PROVIDER_ID : alias ? models.find((model) => (model.gatewayModelId || model.id) === alias.targetModelId)?.providerId ?? null : null)
  const [targetModelId, setTargetModelId] = useState<string | null>(alias?.targetModelId ?? null)
  const localModels = useMemo(() => providerId && providerId !== SHARED_PROVIDER_ID ? models.filter((model) => model.providerId === providerId && model.enabled).sort((a, b) => (a.gatewayModelId || a.id).localeCompare(b.gatewayModelId || b.id)) : [], [models, providerId])
  const availableSharedModels = useMemo(() => sharedModels.filter((model) => model.status === "active"), [sharedModels])
  const selectedShared = providerId === SHARED_PROVIDER_ID ? availableSharedModels.find((model) => model.qualifiedModelId === targetModelId) : undefined
  const selectedLocal = providerId && providerId !== SHARED_PROVIDER_ID ? localModels.find((model) => (model.gatewayModelId || model.id) === targetModelId) : undefined
  const selected = selectedShared || selectedLocal
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!providerId || !selected || !targetModelId) return
    const formData = new FormData(event.currentTarget)
    setPending(true)
    try { await onSave({ originalId: alias?.id || undefined, alias: String(formData.get("alias")), name: String(formData.get("name")), targetModelId, sharedModelId: selectedShared?.id || "" }) }
    finally { setPending(false) }
  }
  return <form onSubmit={submit}><DialogHeader><DialogTitle>{alias?.id ? "Edit alias" : "Add alias"}</DialogTitle><DialogDescription>Create a local gateway ID for an enabled model or a model shared by another workspace.</DialogDescription></DialogHeader><div className="grid gap-4 py-4"><div className="grid gap-4 sm:grid-cols-2"><FormField label="Gateway ID"><Input name="alias" defaultValue={alias?.alias} placeholder="my-cool-model" pattern="[a-z0-9._/-]+" title="Lowercase letters, numbers, dots, underscores, dashes and slashes" required /></FormField><FormField label="Name"><Input name="name" defaultValue={alias?.name} placeholder="My Cool Model" maxLength={80} required /></FormField></div><div className="grid gap-4 sm:grid-cols-2"><FormField label="Provider"><Select value={providerId} onValueChange={(value) => { setProviderId(value); setTargetModelId(null) }} itemToStringLabel={(value) => value === SHARED_PROVIDER_ID ? "Shared Models" : providers.find((provider) => provider.id === value)?.name || String(value)}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent>{providers.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}{sharedModels.length > 0 && <SelectItem value={SHARED_PROVIDER_ID}>Shared Models</SelectItem>}</SelectContent></Select></FormField><FormField label="Model"><Select value={selected ? targetModelId : null} onValueChange={setTargetModelId} disabled={!providerId || (providerId === SHARED_PROVIDER_ID ? !availableSharedModels.length : !localModels.length)} itemToStringLabel={(value) => String(value)}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent>{providerId === SHARED_PROVIDER_ID ? availableSharedModels.map((model) => <SelectItem key={model.id} value={model.qualifiedModelId}><span className="font-mono">{model.qualifiedModelId}</span><span className="ml-2 text-xs text-muted-foreground">{model.ownerWorkspaceName}</span></SelectItem>) : localModels.map((model) => <SelectItem key={model.id} value={model.gatewayModelId || model.id}><span className="font-mono">{model.gatewayModelId || model.id}</span><span className="ml-2 text-xs text-muted-foreground">{model.name}</span></SelectItem>)}</SelectContent></Select></FormField></div></div><DialogFooter><FormSubmitButton pending={pending} idleLabel={alias?.id ? "Save changes" : "Add alias"} pendingLabel="Saving…" /></DialogFooter></form>
}
