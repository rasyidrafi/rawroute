"use client"

import { useMemo, useState, type FormEvent } from "react"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TestTube2Icon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { apiPost } from "@/components/dashboard/api"
import { FormField, FormSubmitButton } from "@/components/dashboard/shared"
import { LoadingSpinner } from "@/components/loading-spinner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { comboMembers, standardReasoningEfforts, supportedReasoningEfforts } from "@/lib/combo-reasoning"
import type { ComboMember, Model, ModelAlias, ModelCombo, SharedModelView } from "@/lib/types"

type TestResult = { status: "verified" | "unverified" | "invalid"; message: string; latencyMs: number }

export function ComboForm({ combo, models, aliases, sharedModels, onSave }: { combo: ModelCombo | null; models: Model[]; aliases: ModelAlias[]; sharedModels: SharedModelView[]; onSave: (combo: Partial<ModelCombo> & { originalId?: string }) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  const [testing, setTesting] = useState<Set<number>>(() => new Set())
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [members, setMembers] = useState<ComboMember[]>(combo ? comboMembers(combo) : [])
  const targets = useMemo(() => {
    const enabledModels = models.filter((model) => model.enabled).map((model) => ({ id: model.gatewayModelId || model.id, label: model.gatewayModelId || model.id, detail: model.name, efforts: supportedReasoningEfforts(model) }))
    const activeSharedIds = new Set(sharedModels.filter((model) => model.status === "active").map((model) => model.id))
    const enabledModelIds = new Set(enabledModels.map((model) => model.id))
    const modelById = new Map(enabledModels.map((model) => [model.id, model]))
    const enabledAliases = aliases.filter((alias) => !alias.sharedModelId ? enabledModelIds.has(alias.targetModelId) : activeSharedIds.has(alias.sharedModelId)).map((alias) => ({ id: alias.alias, label: alias.alias, detail: alias.name, efforts: modelById.get(alias.targetModelId)?.efforts || [...standardReasoningEfforts] }))
    return [...enabledModels, ...enabledAliases].sort((left, right) => left.label.localeCompare(right.label))
  }, [aliases, models, sharedModels])
  const byId = new Map(targets.map((target) => [target.id, target]))

  function updateMember(index: number, update: (member: ComboMember) => ComboMember) {
    setMembers((current) => current.map((member, memberIndex) => memberIndex === index ? { ...update(member), validation: { status: "stale" } } : member))
  }

  function addMember() {
    if (!selectedModel || members.some((member) => member.modelId === selectedModel) || members.length >= 8) return
    setMembers((current) => [...current, { modelId: selectedModel, reasoning: { mode: "inherit" } }])
    setSelectedModel(null)
  }

  function moveMember(index: number, direction: -1 | 1) {
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= members.length) return
    setMembers((current) => { const next = [...current]; [next[index], next[nextIndex]] = [next[nextIndex], next[index]]; return next })
  }

  async function testMember(index: number) {
    setTesting((current) => new Set(current).add(index))
    try {
      const { result } = await apiPost<{ result: TestResult }>("/api/admin/combos/test", { member: members[index] })
      setMembers((current) => current.map((member, memberIndex) => memberIndex === index ? { ...member, validation: { status: result.status, testedAt: new Date().toISOString(), message: result.message } } : member))
      if (result.status === "verified") toast.success(`${members[index].modelId} accepted the reasoning override`)
      else toast.error(result.message)
    } catch (error) { toast.error(error instanceof Error ? error.message : "Test failed") }
    finally { setTesting((current) => { const next = new Set(current); next.delete(index); return next }) }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    setPending(true)
    try { await onSave({ originalId: combo?.id || undefined, combo: String(formData.get("combo")), name: String(formData.get("name")), members, memberModelIds: members.map((member) => member.modelId) }) }
    finally { setPending(false) }
  }

  return <form onSubmit={submit}><DialogHeader><DialogTitle>{combo?.id ? "Edit combo" : "Add combo"}</DialogTitle><DialogDescription>Each fallback can replace the reasoning setting sent by the client.</DialogDescription></DialogHeader><div className="grid max-h-[70vh] gap-4 overflow-y-auto py-4 pr-1"><div className="grid gap-4 sm:grid-cols-2"><FormField label="Gateway ID"><Input name="combo" defaultValue={combo?.combo} placeholder="auto" pattern="[a-z0-9._/-]+" required /></FormField><FormField label="Name"><Input name="name" defaultValue={combo?.name} placeholder="Automatic fallback" maxLength={80} required /></FormField></div><FormField label="Models in fallback order"><div className="flex gap-2"><Select value={selectedModel} onValueChange={setSelectedModel} itemToStringLabel={(value) => byId.get(String(value))?.label || String(value)}><SelectTrigger className="h-9 flex-1"><SelectValue placeholder="Select a model or alias" /></SelectTrigger><SelectContent>{targets.filter((target) => !members.some((member) => member.modelId === target.id)).map((target) => <SelectItem key={target.id} value={target.id}><span className="font-mono">{target.label}</span><span className="ml-2 text-xs text-muted-foreground">{target.detail}</span></SelectItem>)}</SelectContent></Select><Button type="button" variant="outline" disabled={!selectedModel || members.length >= 8} onClick={addMember}><PlusIcon />Add model</Button></div></FormField><div className="grid gap-3">{members.map((member, index) => { const mode = member.reasoning?.mode || "inherit"; const allowed = byId.get(member.modelId)?.efforts || [...standardReasoningEfforts]; return <div key={member.modelId} className="grid gap-3 rounded-lg border p-3"><div className="flex items-center gap-2"><span className="w-5 text-center text-xs text-muted-foreground">{index + 1}</span><span className="min-w-0 flex-1 break-all font-mono text-xs font-medium">{member.modelId}</span>{member.validation?.status && <Badge variant={member.validation.status === "verified" ? "secondary" : member.validation.status === "invalid" ? "destructive" : "outline"}>{member.validation.status}</Badge>}<Button aria-label={`Move ${member.modelId} up`} type="button" size="icon-sm" variant="ghost" disabled={index === 0} onClick={() => moveMember(index, -1)}><ArrowUpIcon /></Button><Button aria-label={`Move ${member.modelId} down`} type="button" size="icon-sm" variant="ghost" disabled={index === members.length - 1} onClick={() => moveMember(index, 1)}><ArrowDownIcon /></Button><Button aria-label={`Remove ${member.modelId}`} type="button" size="icon-sm" variant="ghost" onClick={() => setMembers((current) => current.filter((_, memberIndex) => memberIndex !== index))}><Trash2Icon /></Button></div><div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"><FormField label="Reasoning"><Select value={mode} onValueChange={(value) => value && updateMember(index, (current) => ({ ...current, reasoning: { mode: value as "inherit" | "provider-default" | "override", ...(value === "override" ? { effort: current.reasoning?.effort || allowed[0] || "medium" } : {}) } }))}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">Inherit client</SelectItem><SelectItem value="provider-default">Provider default</SelectItem><SelectItem value="override">Override client</SelectItem></SelectContent></Select></FormField><FormField label="Effort"><Input value={member.reasoning?.effort || ""} list={`efforts-${index}`} placeholder="high" disabled={mode !== "override" || !allowed.length} onChange={(event) => updateMember(index, (current) => ({ ...current, reasoning: { mode: "override", effort: event.target.value } }))} /><datalist id={`efforts-${index}`}>{allowed.map((effort) => <option key={effort} value={effort} />)}</datalist></FormField><div className="flex items-end"><Button type="button" variant="outline" disabled={mode !== "override" || testing.has(index)} onClick={() => void testMember(index)}>{testing.has(index) ? <LoadingSpinner /> : <TestTube2Icon />}Test model</Button></div></div>{member.validation?.message && <p className="text-xs text-muted-foreground">{member.validation.message}</p>}</div>})}{!members.length && <p className="text-sm text-muted-foreground">Add at least two models.</p>}</div></div><DialogFooter><FormSubmitButton pending={pending} idleLabel={combo?.id ? "Save changes" : "Add combo"} pendingLabel="Testing and saving..." /></DialogFooter></form>
}
