import { useId, useMemo, useState } from "react"
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react"
import { Badge } from "@rawroute/ui/badge"
import { Button } from "@rawroute/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@rawroute/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@rawroute/ui/popover"

export type ModelPickerOption = { id: string; name: string; provider?: string | null }

/** Groups picker options by provider; IDs without a recorded provider fall into a trailing group. */
export function groupModelOptions(options: ModelPickerOption[]) {
  const groups = new Map<string, ModelPickerOption[]>()
  for (const option of options) {
    if (!option.id) continue
    const provider = option.provider || "Other models"
    const entries = groups.get(provider) || []
    entries.push(option)
    groups.set(provider, entries)
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (left === "Other models" ? 1 : right === "Other models" ? -1 : left.localeCompare(right)))
    .map(([provider, models]) => ({ provider, models: [...models].sort((left, right) => left.name.localeCompare(right.name)) }))
}

/** Searchable model filter: provider groups and gateway IDs keep duplicate display names distinguishable. */
export function ModelPicker({ label, value, options, onChange }: { label: string; value: string; options: ModelPickerOption[]; onChange: (value: string) => void }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const groups = useMemo(() => groupModelOptions(options), [options])
  const selected = options.find(option => option.id === value)
  const select = (next: string) => { onChange(next); setOpen(false) }
  return <div className="flex min-w-0 max-w-full items-center gap-2">
    <label htmlFor={id} className="shrink-0 text-xs font-medium text-muted-foreground">{label}</label>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button id={id} aria-label={label} variant="outline" size="sm" className="min-w-0 max-w-64 justify-between"><span className="min-w-0 flex-1 truncate">{selected?.name || value || "All models"}</span>{selected?.provider && <Badge variant="outline" className="max-w-28"><span className="truncate">{selected.provider}</span></Badge>}<ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-50" /></Button>} />
      <PopoverContent side="bottom" align="start" sideOffset={4} padding="none" className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden">
        <Command variant="embedded" className="h-auto max-h-(--available-height)">
          <CommandInput placeholder="Search name, ID, or provider..." aria-label={`Search ${label.toLowerCase()}`} />
          <CommandList variant="padded">
            <CommandItem value="all models" forceMount onSelect={() => select("")}>All models{!value && <CheckIcon aria-hidden className="ml-auto size-4" />}</CommandItem>
            {groups.map(group => <CommandGroup variant="flush" key={group.provider} heading={`${group.provider} (${group.models.length})`}>
              {group.models.map(model => <CommandItem key={model.id} value={`${model.name} ${model.id} ${model.provider || ""}`} onSelect={() => select(model.id)}>
                <div className="min-w-0 flex-1"><div className="truncate font-medium">{model.name}</div>{model.name !== model.id && <div className="truncate font-mono text-xs text-muted-foreground">{model.id}</div>}</div>
                {value === model.id && <CheckIcon aria-hidden className="size-4" />}
              </CommandItem>)}
            </CommandGroup>)}
            <CommandEmpty>No models match your search.</CommandEmpty>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  </div>
}
