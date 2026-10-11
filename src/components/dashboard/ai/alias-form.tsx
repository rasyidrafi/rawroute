import { useMemo, useState, type FormEvent } from "react"
import { BoxesIcon, SearchIcon, ServerIcon } from "lucide-react"

import { FormField, FormSubmitButton } from "@/components/dashboard/shared"
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Model, ModelAlias, Provider, SharedModelView } from "@/lib/types"

const SHARED_PROVIDER_ID = "__shared_models__"
const EMPTY_SHARED_MODELS: SharedModelView[] = []

export function AliasForm({ alias, providers, models, sharedModels = EMPTY_SHARED_MODELS, onSave }: { alias: ModelAlias | null; providers: Provider[]; models: Model[]; sharedModels?: SharedModelView[]; onSave: (alias: Partial<ModelAlias> & { originalId?: string }) => Promise<boolean> }) {
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
  return <form onSubmit={submit}>
    <DialogHeader><DialogTitle>{alias?.id ? "Edit alias" : "Add alias"}</DialogTitle><DialogDescription>Create a local gateway ID for an enabled model or a model shared by another workspace.</DialogDescription></DialogHeader>
    <div className="grid gap-4 py-4">
      <div className="grid gap-4 sm:grid-cols-2"><FormField label="Gateway ID"><Input name="alias" defaultValue={alias?.alias} placeholder="my-cool-model" pattern="[a-z0-9._/-]+" title="Lowercase letters, numbers, dots, underscores, dashes and slashes" required /></FormField><FormField label="Name"><Input name="name" defaultValue={alias?.name} placeholder="My Cool Model" maxLength={80} required /></FormField></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <AliasProviderField providers={providers} sharedModels={sharedModels} availableSharedModels={availableSharedModels} providerId={providerId} onProviderChange={(value) => { setProviderId(value); setTargetModelId(null) }} />
        <AliasModelField providerId={providerId} targetModelId={targetModelId} selected={Boolean(selected)} availableSharedModels={availableSharedModels} localModels={localModels} onModelChange={setTargetModelId} />
      </div>
    </div>
    <DialogFooter><FormSubmitButton pending={pending} idleLabel={alias?.id ? "Save changes" : "Add alias"} pendingLabel="Saving…" /></DialogFooter>
  </form>
}

function AliasProviderField({ providers, sharedModels, availableSharedModels, providerId, onProviderChange }: {
  providers: Provider[]
  sharedModels: SharedModelView[]
  availableSharedModels: SharedModelView[]
  providerId: string | null
  onProviderChange: (providerId: string | null) => void
}) {
  return <FormField label="Provider">
    <div className="grid gap-2">
      <Select value={providerId} onValueChange={onProviderChange} itemToStringLabel={(value) => value === SHARED_PROVIDER_ID ? "Shared Models" : providers.find((provider) => provider.id === value)?.name || String(value)}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent>{providers.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}{sharedModels.length > 0 && <SelectItem value={SHARED_PROVIDER_ID}>Shared Models</SelectItem>}</SelectContent></Select>
      {!providers.length && !availableSharedModels.length && <EmptyState title="No model targets available" description="Add a provider or share a model into this workspace before creating an alias." icon={ServerIcon} variant="compact" treatment="embedded" />}
    </div>
  </FormField>
}

function AliasModelField({ providerId, targetModelId, selected, availableSharedModels, localModels, onModelChange }: {
  providerId: string | null
  targetModelId: string | null
  selected: boolean
  availableSharedModels: SharedModelView[]
  localModels: Model[]
  onModelChange: (modelId: string | null) => void
}) {
  const sharedProvider = providerId === SHARED_PROVIDER_ID
  const models = sharedProvider ? availableSharedModels : localModels

  return <FormField label="Model">
    <div className="grid gap-2">
      <Select value={selected ? targetModelId : null} onValueChange={onModelChange} disabled={!providerId || !models.length} itemToStringLabel={(value) => String(value)}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent>{sharedProvider ? availableSharedModels.map((model) => <SelectItem key={model.id} value={model.qualifiedModelId}><span className="font-mono">{model.qualifiedModelId}</span><span className="ml-2 text-xs text-muted-foreground">{model.ownerWorkspaceName}</span></SelectItem>) : localModels.map((model) => <SelectItem key={model.id} value={model.gatewayModelId || model.id}><span className="font-mono">{model.gatewayModelId || model.id}</span><span className="ml-2 text-xs text-muted-foreground">{model.name}</span></SelectItem>)}</SelectContent></Select>
      {providerId && !models.length && <EmptyState title={sharedProvider ? "No active shared models" : "No enabled models for this provider"} description={sharedProvider ? "Active shared models will appear here when available." : "Enable or add a provider model before creating an alias."} icon={sharedProvider ? SearchIcon : BoxesIcon} variant="compact" treatment="embedded" />}
    </div>
  </FormField>
}
