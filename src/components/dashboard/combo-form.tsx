"use client"

import { useMemo, useState, type FormEvent } from "react"
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { BracesIcon, ChevronDownIcon, GripVerticalIcon, PlusIcon, TestTube2Icon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { apiPost } from "@/components/dashboard/api"
import { FormField, FormSubmitButton } from "@/components/dashboard/shared"
import { LoadingSpinner } from "@/components/loading-spinner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { comboMembers, memberPolicyConfigHash, normalizeComboCustomPayload, protectedComboPayloadFields, standardReasoningEfforts, supportedReasoningEfforts } from "@/lib/combo-reasoning"
import { cn } from "@/lib/utils"
import type { ComboMember, Model, ModelAlias, ModelCombo, SharedModelView } from "@/lib/types"

type TestResult = { status: "verified" | "unverified" | "invalid"; message: string; latencyMs: number }

function validationVariant(status: "verified" | "unverified" | "invalid" | "stale") {
  return status === "verified" ? "secondary" : status === "invalid" ? "destructive" : "outline"
}

function SortableMemberCard({ member, index, open, effortOptions, payloadDraft, payloadError, testing, onToggle, onRemove, onUpdate, onPayloadChange, onFormatPayload, onTest }: {
  member: ComboMember
  index: number
  open: boolean
  effortOptions: string[]
  payloadDraft: string
  payloadError?: string
  testing: boolean
  onToggle: () => void
  onRemove: () => void
  onUpdate: (update: (member: ComboMember) => ComboMember) => void
  onPayloadChange: (value: string) => void
  onFormatPayload: () => void
  onTest: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: member.modelId })
  const mode = member.reasoning?.mode || "inherit"
  const panelId = `combo-member-${index}`
  const configured = mode !== "inherit" || Boolean(member.customPayload)

  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn("rounded-lg border bg-background shadow-sm transition-shadow", isDragging && "relative z-20 shadow-lg ring-2 ring-ring/30")}>
    <div className="flex min-h-12 items-center gap-2 px-2 py-2 sm:px-3">
      <Button {...attributes} {...listeners} type="button" size="icon-sm" variant="ghost" className="cursor-grab touch-none text-muted-foreground active:cursor-grabbing" aria-label={`Drag ${member.modelId} to reorder`}><GripVerticalIcon /></Button>
      <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
        <span className="min-w-0 truncate font-mono text-xs font-semibold">{member.modelId}</span>
        {mode === "override" && <Badge variant="outline">{member.reasoning?.effort}</Badge>}
        {mode === "provider-default" && <Badge variant="outline">Default</Badge>}
        {member.customPayload && <Badge variant="outline">Custom</Badge>}
        {!configured && <span className="hidden text-xs text-muted-foreground sm:inline">No overrides</span>}
        {member.validation?.status && configured && <Badge variant={validationVariant(member.validation.status)}>{member.validation.status}</Badge>}
      </button>
      <Button type="button" size="icon-sm" variant="ghost" aria-label={`${open ? "Collapse" : "Configure"} ${member.modelId}`} aria-expanded={open} aria-controls={panelId} onClick={onToggle}><ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} /></Button>
      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${member.modelId}`} onClick={onRemove}><Trash2Icon /></Button>
    </div>

    {open && <div id={panelId} className="grid gap-3 border-t bg-muted/10 p-3 sm:p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <FormField label="Reasoning"><Select value={mode} onValueChange={(value) => value && onUpdate((current) => ({ ...current, reasoning: { mode: value as "inherit" | "provider-default" | "override", ...(value === "override" ? { effort: current.reasoning?.effort || effortOptions[0] || "medium" } : {}) } }))}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">Inherit client</SelectItem><SelectItem value="provider-default">Provider default</SelectItem><SelectItem value="override">Override client</SelectItem></SelectContent></Select></FormField>
        <FormField label="Effort"><Input value={member.reasoning?.effort || ""} list={`efforts-${index}`} placeholder="high" disabled={mode !== "override" || !effortOptions.length} onChange={(event) => onUpdate((current) => ({ ...current, reasoning: { mode: "override", effort: event.target.value } }))} /><datalist id={`efforts-${index}`}>{effortOptions.map((effort) => <option key={effort} value={effort} />)}</datalist></FormField>
        <div className="flex items-end"><Button type="button" variant="outline" disabled={Boolean(payloadError) || testing || mode !== "override" && !member.customPayload} onClick={onTest}>{testing ? <LoadingSpinner /> : <TestTube2Icon />}Test model</Button></div>
      </div>

      <details className="rounded-md border bg-background" open={Boolean(payloadError)}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium"><BracesIcon className="size-4" />Custom payload{member.customPayload && <span className="text-xs font-normal text-muted-foreground">Configured</span>}<ChevronDownIcon className="ml-auto size-4" /></summary>
        <div className="grid gap-2 border-t p-3"><Textarea aria-label={`Custom payload for ${member.modelId}`} value={payloadDraft} onChange={(event) => onPayloadChange(event.target.value)} className="min-h-32 font-mono text-xs" spellCheck={false} /><div className="flex flex-wrap items-center justify-between gap-2"><p className={payloadError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{payloadError || `Protected: ${protectedComboPayloadFields.join(", ")}. Nested objects merge; arrays and values replace.`}</p><div className="flex gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => onPayloadChange("{}")}>Clear</Button><Button type="button" size="sm" variant="outline" onClick={onFormatPayload}>Format JSON</Button></div></div></div>
      </details>
      {member.validation?.message && configured && <p className="text-xs text-muted-foreground">{member.validation.message}</p>}
    </div>}
  </div>
}

export function ComboForm({ combo, models, aliases, sharedModels, onSave }: { combo: ModelCombo | null; models: Model[]; aliases: ModelAlias[]; sharedModels: SharedModelView[]; onSave: (combo: Partial<ModelCombo> & { originalId?: string }) => Promise<boolean> }) {
  const initialMembers = combo ? comboMembers(combo) : []
  const [pending, setPending] = useState(false)
  const [testing, setTesting] = useState<Set<string>>(() => new Set())
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [members, setMembers] = useState<ComboMember[]>(initialMembers)
  const [openMembers, setOpenMembers] = useState<Set<string>>(() => new Set())
  const [payloadDrafts, setPayloadDrafts] = useState<Record<string, string>>(() => Object.fromEntries(initialMembers.map((member) => [member.modelId, JSON.stringify(member.customPayload || {}, null, 2)])))
  const [payloadErrors, setPayloadErrors] = useState<Record<string, string>>({})
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const targets = useMemo(() => {
    const enabledModels = models.filter((model) => model.enabled).map((model) => ({ id: model.gatewayModelId || model.id, label: model.gatewayModelId || model.id, detail: model.name, efforts: supportedReasoningEfforts(model) }))
    const activeSharedIds = new Set(sharedModels.filter((model) => model.status === "active").map((model) => model.id))
    const enabledModelIds = new Set(enabledModels.map((model) => model.id))
    const modelById = new Map(enabledModels.map((model) => [model.id, model]))
    const enabledAliases = aliases.filter((alias) => !alias.sharedModelId ? enabledModelIds.has(alias.targetModelId) : activeSharedIds.has(alias.sharedModelId)).map((alias) => ({ id: alias.alias, label: alias.alias, detail: alias.name, efforts: modelById.get(alias.targetModelId)?.efforts || [...standardReasoningEfforts] }))
    return [...enabledModels, ...enabledAliases].sort((left, right) => left.label.localeCompare(right.label))
  }, [aliases, models, sharedModels])
  const byId = new Map(targets.map((target) => [target.id, target]))

  function updateMember(modelId: string, update: (member: ComboMember) => ComboMember) {
    setMembers((current) => current.map((member) => {
      if (member.modelId !== modelId) return member
      const updated = update(member)
      return memberPolicyConfigHash(member) === memberPolicyConfigHash(updated) ? { ...updated, validation: member.validation } : { ...updated, validation: { status: "stale" } }
    }))
  }

  function addMember() {
    if (!selectedModel || members.some((member) => member.modelId === selectedModel) || members.length >= 8) return
    setMembers((current) => [...current, { modelId: selectedModel, reasoning: { mode: "inherit" } }])
    setPayloadDrafts((current) => ({ ...current, [selectedModel]: "{}" }))
    setOpenMembers((current) => new Set(current).add(selectedModel))
    setSelectedModel(null)
  }

  function removeMember(modelId: string) {
    setMembers((current) => current.filter((member) => member.modelId !== modelId))
    setOpenMembers((current) => { const next = new Set(current); next.delete(modelId); return next })
    setPayloadDrafts((current) => { const next = { ...current }; delete next[modelId]; return next })
    setPayloadErrors((current) => { const next = { ...current }; delete next[modelId]; return next })
  }

  function toggleMember(modelId: string) {
    setOpenMembers((current) => { const next = new Set(current); if (next.has(modelId)) next.delete(modelId); else next.add(modelId); return next })
  }

  function updateCustomPayload(modelId: string, value: string) {
    setPayloadDrafts((current) => ({ ...current, [modelId]: value }))
    try {
      const parsed = value.trim() ? JSON.parse(value) as unknown : {}
      const customPayload = normalizeComboCustomPayload(parsed)
      setPayloadErrors((current) => { const next = { ...current }; delete next[modelId]; return next })
      updateMember(modelId, (member) => ({ ...member, customPayload }))
    } catch (error) {
      setPayloadErrors((current) => ({ ...current, [modelId]: error instanceof Error ? error.message : "Custom payload is invalid." }))
    }
  }

  function formatCustomPayload(modelId: string) {
    try { updateCustomPayload(modelId, JSON.stringify(JSON.parse(payloadDrafts[modelId] || "{}"), null, 2)) }
    catch { setPayloadErrors((current) => ({ ...current, [modelId]: "Custom payload is not valid JSON." })) }
  }

  function reorderMembers(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return
    setMembers((current) => {
      const oldIndex = current.findIndex((member) => member.modelId === event.active.id)
      const newIndex = current.findIndex((member) => member.modelId === event.over?.id)
      return oldIndex < 0 || newIndex < 0 ? current : arrayMove(current, oldIndex, newIndex)
    })
  }

  async function testMember(modelId: string) {
    const member = members.find((entry) => entry.modelId === modelId)
    if (!member) return
    setTesting((current) => new Set(current).add(modelId))
    try {
      const { result } = await apiPost<{ result: TestResult }>("/api/admin/combos/test", { member })
      setMembers((current) => current.map((entry) => entry.modelId === modelId ? { ...entry, validation: { status: result.status, testedAt: new Date().toISOString(), message: result.message } } : entry))
      if (result.status === "verified") toast.success(`${modelId} accepted the member policy`)
      else toast.error(result.message)
    } catch (error) { toast.error(error instanceof Error ? error.message : "Test failed") }
    finally { setTesting((current) => { const next = new Set(current); next.delete(modelId); return next }) }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (members.some((member) => payloadErrors[member.modelId])) { toast.error("Fix the custom payload JSON before saving."); return }
    const formData = new FormData(event.currentTarget)
    setPending(true)
    try { await onSave({ originalId: combo?.id || undefined, combo: String(formData.get("combo")), name: String(formData.get("name")), members, memberModelIds: members.map((member) => member.modelId) }) }
    finally { setPending(false) }
  }

  return <form onSubmit={submit}>
    <DialogHeader><DialogTitle>{combo?.id ? "Edit combo" : "Add combo"}</DialogTitle><DialogDescription>Drag models into fallback order. Open a model only when it needs an override.</DialogDescription></DialogHeader>
    <div className="grid max-h-[70vh] gap-4 overflow-y-auto py-4 pr-1">
      <div className="grid gap-4 sm:grid-cols-2"><FormField label="Gateway ID"><Input name="combo" defaultValue={combo?.combo} placeholder="auto" pattern="[a-z0-9._/-]+" required /></FormField><FormField label="Name"><Input name="name" defaultValue={combo?.name} placeholder="Automatic fallback" maxLength={80} required /></FormField></div>
      <FormField label="Models in fallback order"><div className="flex gap-2"><Select value={selectedModel} onValueChange={setSelectedModel} itemToStringLabel={(value) => byId.get(String(value))?.label || String(value)}><SelectTrigger className="h-9 flex-1"><SelectValue placeholder="Select a model or alias" /></SelectTrigger><SelectContent>{targets.filter((target) => !members.some((member) => member.modelId === target.id)).map((target) => <SelectItem key={target.id} value={target.id}><span className="font-mono">{target.label}</span><span className="ml-2 text-xs text-muted-foreground">{target.detail}</span></SelectItem>)}</SelectContent></Select><Button type="button" variant="outline" disabled={!selectedModel || members.length >= 8} onClick={addMember}><PlusIcon />Add model</Button></div></FormField>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorderMembers}>
        <SortableContext items={members.map((member) => member.modelId)} strategy={verticalListSortingStrategy}>
          <div className="grid gap-2">{members.map((member, index) => <SortableMemberCard key={member.modelId} member={member} index={index} open={openMembers.has(member.modelId)} effortOptions={byId.get(member.modelId)?.efforts || [...standardReasoningEfforts]} payloadDraft={payloadDrafts[member.modelId] ?? JSON.stringify(member.customPayload || {}, null, 2)} payloadError={payloadErrors[member.modelId]} testing={testing.has(member.modelId)} onToggle={() => toggleMember(member.modelId)} onRemove={() => removeMember(member.modelId)} onUpdate={(update) => updateMember(member.modelId, update)} onPayloadChange={(value) => updateCustomPayload(member.modelId, value)} onFormatPayload={() => formatCustomPayload(member.modelId)} onTest={() => void testMember(member.modelId)} />)}{!members.length && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Add at least two models.</p>}</div>
        </SortableContext>
      </DndContext>
    </div>
    <DialogFooter><FormSubmitButton pending={pending} disabled={members.some((member) => Boolean(payloadErrors[member.modelId]))} idleLabel={combo?.id ? "Save changes" : "Add combo"} pendingLabel="Testing and saving..." /></DialogFooter>
  </form>
}
