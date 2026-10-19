import { useId, useMemo, useState } from "react"
import { DatabaseIcon, SearchIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { EmptyState } from "@/components/ui/empty-state"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type { RoutingModelOption } from "@/lib/catalog"

export function BudgetModelSelector({ title, description, modelIds, modelOptions, pending, onChange }: {
  title: string
  description: string
  modelIds: string[]
  modelOptions: RoutingModelOption[]
  pending: boolean
  onChange: (modelIds: string[]) => void
}) {
  const selectorId = useId()
  const [search, setSearch] = useState("")
  const normalizedSearch = search.trim().toLowerCase()
  const options = useMemo(() => {
    const selected = new Set(modelIds)
    const entries = new Map(modelOptions.map((model) => [model.id, model]))
    for (const id of modelIds) {
      if (!entries.has(id)) entries.set(id, { id, name: id, provider: "Unavailable", kind: "model", available: false, unavailableReason: "Model or routing entry removed", members: [] })
    }
    return [...entries.values()].filter((model) => model.available || selected.has(model.id))
  }, [modelIds, modelOptions])
  const filtered = options.filter((model) => !normalizedSearch || `${model.name} ${model.id} ${model.provider} ${model.members.join(" ")}`.toLowerCase().includes(normalizedSearch))
  const selectedIds = new Set(modelIds)
  const toggleModel = (id: string, selected: boolean) => onChange(selected ? [...new Set([...modelIds, id])] : modelIds.filter((modelId) => modelId !== id))

  return <FieldSet>
    <FieldLegend variant="label">{title}</FieldLegend>
    <div className="flex items-center gap-2"><Badge variant="outline">{modelIds.length} selected</Badge>{modelIds.length > 0 && <Button size="sm" variant="ghost" disabled={pending} onClick={() => onChange([])}>Clear all</Button>}</div>
    <FieldDescription>{description}</FieldDescription>
    <Input aria-label={`Search ${title.toLowerCase()}`} placeholder="Search model name, ID, or provider" value={search} onChange={(event) => setSearch(event.target.value)} disabled={pending} />
    <div className="max-h-80 overflow-y-auto rounded-lg border p-3"><FieldGroup>
      {filtered.map((model) => {
        const selected = selectedIds.has(model.id)
        const disabled = pending || (!model.available && !selected)
        const checkboxId = `${selectorId}-${encodeURIComponent(model.id)}`
        return <Field key={model.id} orientation="horizontal" data-disabled={disabled}>
          <Checkbox id={checkboxId} checked={selected} onCheckedChange={(checked) => toggleModel(model.id, checked === true)} disabled={disabled} />
          <FieldContent>
            <FieldLabel htmlFor={checkboxId}>{model.name}{!model.available && <Badge variant="outline">Unavailable</Badge>}</FieldLabel>
            <FieldDescription>{model.id} · {model.provider}</FieldDescription>
            {model.members.length > 0 && <FieldDescription>Members: {model.members.join(" → ")}</FieldDescription>}
            {!model.available && <FieldDescription>{model.unavailableReason}. Remove this selection or keep it for when the model returns.</FieldDescription>}
          </FieldContent>
        </Field>
      })}
      {!filtered.length && <EmptyState title={options.length ? "No models match your search" : "No enabled models available"} description={options.length ? "Try a different model name, ID, or provider." : "Enable or add a model before selecting it here."} icon={options.length ? SearchIcon : DatabaseIcon} variant="compact" treatment="embedded" />}
    </FieldGroup></div>
  </FieldSet>
}
