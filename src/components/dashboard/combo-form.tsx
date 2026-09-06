"use client"

import { useMemo, useState, type FormEvent } from "react"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { FormField, FormSubmitButton } from "@/components/dashboard/shared"
import { Button } from "@/components/ui/button"
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Model, ModelAlias, ModelCombo, SharedModelView } from "@/lib/types"

export function ComboForm({ combo, models, aliases, sharedModels, onSave }: { combo: ModelCombo | null; models: Model[]; aliases: ModelAlias[]; sharedModels: SharedModelView[]; onSave: (combo: Partial<ModelCombo> & { originalId?: string }) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [members, setMembers] = useState<string[]>(combo?.memberModelIds || [])
  const targets = useMemo(() => {
    const enabledModels = models.filter((model) => model.enabled).map((model) => ({ id: model.gatewayModelId || model.id, label: model.gatewayModelId || model.id, detail: model.name }))
    const activeSharedIds = new Set(sharedModels.filter((model) => model.status === "active").map((model) => model.id))
    const enabledModelIds = new Set(enabledModels.map((model) => model.id))
    const enabledAliases = aliases.filter((alias) => !alias.sharedModelId ? enabledModelIds.has(alias.targetModelId) : activeSharedIds.has(alias.sharedModelId)).map((alias) => ({ id: alias.alias, label: alias.alias, detail: alias.name }))
    return [...enabledModels, ...enabledAliases].sort((left, right) => left.label.localeCompare(right.label))
  }, [aliases, models, sharedModels])
  const byId = new Map(targets.map((target) => [target.id, target]))

  function addMember() {
    if (!selectedModel || members.includes(selectedModel) || members.length >= 8) return
    setMembers((current) => [...current, selectedModel])
    setSelectedModel(null)
  }

  function moveMember(index: number, direction: -1 | 1) {
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= members.length) return
    setMembers((current) => {
      const next = [...current]
      ;[next[index], next[nextIndex]] = [next[nextIndex], next[index]]
      return next
    })
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    setPending(true)
    try { await onSave({ originalId: combo?.id || undefined, combo: String(formData.get("combo")), name: String(formData.get("name")), memberModelIds: members }) }
    finally { setPending(false) }
  }

  return <form onSubmit={submit}><DialogHeader><DialogTitle>{combo?.id ? "Edit combo" : "Add combo"}</DialogTitle><DialogDescription>Try models in this order until one accepts the request.</DialogDescription></DialogHeader><div className="grid gap-4 py-4"><div className="grid gap-4 sm:grid-cols-2"><FormField label="Gateway ID"><Input name="combo" defaultValue={combo?.combo} placeholder="my-coding-fallback" pattern="[a-z0-9._/-]+" title="Lowercase letters, numbers, dots, underscores, dashes and slashes" required /></FormField><FormField label="Name"><Input name="name" defaultValue={combo?.name} placeholder="My coding fallback" maxLength={80} required /></FormField></div><FormField label="Models in fallback order"><div className="flex gap-2"><Select value={selectedModel} onValueChange={setSelectedModel} itemToStringLabel={(value) => byId.get(String(value))?.label || String(value)}><SelectTrigger className="h-9 flex-1"><SelectValue placeholder="Select a model or alias" /></SelectTrigger><SelectContent>{targets.filter((target) => !members.includes(target.id)).map((target) => <SelectItem key={target.id} value={target.id}><span className="font-mono">{target.label}</span><span className="ml-2 text-xs text-muted-foreground">{target.detail}</span></SelectItem>)}</SelectContent></Select><Button type="button" variant="outline" disabled={!selectedModel || members.length >= 8} onClick={addMember}><PlusIcon />Add model</Button></div></FormField><div className="grid gap-2">{members.map((member, index) => <div key={member} className="flex items-center gap-2 rounded-md border p-2"><span className="w-5 text-center text-xs text-muted-foreground">{index + 1}</span><span className="min-w-0 flex-1 break-all font-mono text-xs">{member}</span><Button aria-label={`Move ${member} up`} type="button" size="icon-sm" variant="ghost" disabled={index === 0} onClick={() => moveMember(index, -1)}><ArrowUpIcon /></Button><Button aria-label={`Move ${member} down`} type="button" size="icon-sm" variant="ghost" disabled={index === members.length - 1} onClick={() => moveMember(index, 1)}><ArrowDownIcon /></Button><Button aria-label={`Remove ${member}`} type="button" size="icon-sm" variant="ghost" onClick={() => setMembers((current) => current.filter((entry) => entry !== member))}><Trash2Icon /></Button></div>)}{!members.length && <p className="text-sm text-muted-foreground">Add at least two models.</p>}</div></div><DialogFooter><FormSubmitButton pending={pending} idleLabel={combo?.id ? "Save changes" : "Add combo"} pendingLabel="Saving…" /></DialogFooter></form>
}
