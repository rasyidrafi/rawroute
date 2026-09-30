"use client"

import { useEffect, useMemo, useState } from "react"
import { AlertTriangleIcon, CheckIcon, ChevronsUpDownIcon, DollarSignIcon, PencilIcon, PlusIcon } from "lucide-react"
import { LegendList } from "@legendapp/list/react"
import { toast } from "sonner"
import useSWR from "swr"

import { apiFetch, apiPost, fetcher } from "@/components/dashboard/api"
import { ConfirmAction, EmptyRow } from "@/components/dashboard/shared"
import { formatCost } from "@/components/dashboard/usage-utils"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { LoadingSpinner } from "@/components/loading-spinner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatAppDate } from "@/lib/timezone"
import type { CanonicalModelSummary, ModelPricingGroup, ModelPricingVersion, PricingCanonicalSource, PricingContextTier, PricingJob, PricingRates } from "@/lib/types"

import { Panel, sanitizeNonNegativeDraft } from "@/components/dashboard/management-panel"

type PricingModelRow = { id: string; name: string; groupKey: string; gatewayModelId: string; upstreamModel: string; providerId: string; enabled: boolean }
type PricingGroupRow = ModelPricingGroup & { canonicalModel: CanonicalModelSummary | null; versions: ModelPricingVersion[]; currentVersion: ModelPricingVersion | null }
type PricingAdminData = { groups: PricingGroupRow[]; models: PricingModelRow[]; ungroupedModels: PricingModelRow[]; jobs: PricingJob[] }
type ModelSelectionRow =
  | { type: "heading"; id: string; label: string; count: number }
  | { type: "model"; id: string; model: PricingModelRow }
type CanonicalModelsResponse = { models: CanonicalModelSummary[] }

const blankRates = (): PricingRates => ({ inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, cacheReadMicrosPerMillion: 0, cacheCreationMicrosPerMillion: 0 })
const rateFields = [
  ["inputMicrosPerMillion", "Input"],
  ["outputMicrosPerMillion", "Output"],
  ["cacheReadMicrosPerMillion", "Cache read"],
  ["cacheCreationMicrosPerMillion", "Cache creation"],
] as const

function formatRate(value: number) { return `${formatCost(value)} / 1M` }
function formatDollarInput(value: number) { return value === 0 ? "0" : String(value / 1_000_000) }
function parseDollarInput(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1_000_000) : 0
}
function formatCanonicalRate(value: number) { return formatCost(value) }
function canonicalSourceLabel(value: PricingCanonicalSource) { return value === "models.dev" ? "models.dev" : "Custom ID" }

export function ModelPricingView() {
  const { data, mutate, isValidating } = useSWR<PricingAdminData>("/api/admin/model-pricing", fetcher, {
    refreshInterval: (latest) => latest?.jobs.some((job) => job.status === "queued" || job.status === "running") ? 3000 : 0,
    refreshWhenHidden: false,
    dedupingInterval: 2000,
  })
  const [pending, setPending] = useState(false)
  const [groupDialog, setGroupDialog] = useState<string | "new">()
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [groupName, setGroupName] = useState("")
  const [pricingDialog, setPricingDialog] = useState<string>()
  const [rates, setRates] = useState<PricingRates>(blankRates())
  const [rateDrafts, setRateDrafts] = useState<Record<keyof PricingRates, string>>({ inputMicrosPerMillion: "0", outputMicrosPerMillion: "0", cacheReadMicrosPerMillion: "0", cacheCreationMicrosPerMillion: "0" })
  const [contextTiers, setContextTiers] = useState<PricingContextTier[]>([])
  const [tierRateDrafts, setTierRateDrafts] = useState<Record<string, Partial<Record<keyof PricingRates, string>>>>({})
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [canonicalModelId, setCanonicalModelId] = useState("")
  const [canonicalModel, setCanonicalModel] = useState<CanonicalModelSummary | null>(null)
  const [canonicalPopoverOpen, setCanonicalPopoverOpen] = useState(false)
  const [canonicalSearch, setCanonicalSearch] = useState("")
  const [canonicalDebouncedSearch, setCanonicalDebouncedSearch] = useState("")
  const [canonicalModels, setCanonicalModels] = useState<CanonicalModelSummary[]>([])
  const [canonicalLoading, setCanonicalLoading] = useState(false)
  const [canonicalError, setCanonicalError] = useState<string | null>(null)

  function groupById(id: string) { return data?.groups.find((group) => group.id === id) }
  const editingGroup = groupDialog && groupDialog !== "new" ? groupById(groupDialog) : undefined
  function startGroupEdit(id: string | "new") {
    const group = id === "new" ? undefined : groupById(id)
    setGroupDialog(id)
    setGroupName(group?.name || "")
    setSelectedModels(group?.memberModelIds || [])
    setCanonicalModelId(group?.canonicalModelId || "")
    setCanonicalModel(group?.canonicalModel || null)
    setCanonicalSearch("")
    setCanonicalDebouncedSearch("")
    setCanonicalModels([])
    setCanonicalError(null)
    setCanonicalPopoverOpen(false)
  }
  function startPricingEdit(id: string) {
    const version = groupById(id)?.currentVersion
    const nextRates = version ? { inputMicrosPerMillion: version.inputMicrosPerMillion, outputMicrosPerMillion: version.outputMicrosPerMillion, cacheReadMicrosPerMillion: version.cacheReadMicrosPerMillion, cacheCreationMicrosPerMillion: version.cacheCreationMicrosPerMillion } : blankRates()
    const nextTiers = Array.isArray(version?.contextTiers) ? version.contextTiers : []
    setPricingDialog(id)
    setRates(nextRates)
    setRateDrafts(Object.fromEntries(rateFields.map(([field]) => [field, formatDollarInput(nextRates[field])])) as Record<keyof PricingRates, string>)
    setContextTiers(nextTiers)
    setTierRateDrafts(Object.fromEntries(nextTiers.map((tier) => [tier.id, Object.fromEntries(rateFields.map(([field]) => [field, formatDollarInput(tier[field])]))])) as Record<string, Partial<Record<keyof PricingRates, string>>>)
  }
  async function refreshGroups() {
    setPending(true)
    try { await apiPost("/api/admin/model-pricing", { action: "sync" }); await mutate() }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to refresh model groups") }
    finally { setPending(false) }
  }
  async function saveGroup() {
    if (!groupDialog) return
    setPending(true)
    try {
      const canonical = canonicalModelId.trim() ? { canonicalModelId: canonicalModelId.trim(), canonicalSource: "models.dev" as const, canonicalModelName: canonicalModel?.name, canonicalProvider: canonicalModel?.provider } : { canonicalModelId: null }
      const result = groupDialog === "new"
        ? await apiPost<{ group: ModelPricingGroup }>("/api/admin/model-pricing", { action: "create-group", name: groupName, modelIds: selectedModels, ...canonical })
        : await apiPost<{ group: ModelPricingGroup }>("/api/admin/model-pricing", { action: "update-group", groupId: groupDialog, name: groupName, modelIds: selectedModels, ...canonical })
      const catalogPricing = canonicalModel?.pricing
      const currentPricing = editingGroup?.currentVersion
      const pricingChanged = catalogPricing && (!currentPricing || rateFields.some(([field]) => currentPricing[field] !== catalogPricing[field]) || (currentPricing.contextTiers?.length || 0) > 0)
      if (catalogPricing && pricingChanged) await apiPost("/api/admin/model-pricing", { action: "save-version", groupId: result.group.id, mode: "new", ...catalogPricing, contextTiers: [] })
      await mutate(); setGroupDialog(undefined)
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to save model group") }
    finally { setPending(false) }
  }
  async function saveVersion(mode: "new" | "replace") {
    if (!pricingDialog) return
    setPending(true)
    try { await apiPost("/api/admin/model-pricing", { action: "save-version", groupId: pricingDialog, mode, ...rates, contextTiers }); await mutate(); setPricingDialog(undefined); setReplaceOpen(false); toast.success(mode === "replace" ? "Pricing replaced; historical usage is being repriced." : "New pricing version saved.") }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to save pricing version") }
    finally { setPending(false) }
  }
  async function deleteGroup(id: string) {
    setPending(true)
    try { await apiPost("/api/admin/model-pricing", { action: "delete-group", groupId: id }); await mutate(); return true }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to delete model group"); return false }
    finally { setPending(false) }
  }
  function toggleModel(modelId: string) { setSelectedModels((current) => current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId]) }
  function modelsForGroup(group?: PricingGroupRow) {
    const memberModelIds = Array.isArray(group?.memberModelIds) ? group.memberModelIds : []
    return data?.models.filter((model) => memberModelIds.includes(model.id)) || []
  }
  const modelSelectionRows = useMemo<ModelSelectionRow[]>(() => {
    if (!data) return []
    const selected = new Set(selectedModels)
    const currentIds = new Set(editingGroup?.memberModelIds || [])
    const ungroupedIds = new Set(data.ungroupedModels.map((model) => model.id))
    const candidates = data.models.filter((model) => currentIds.has(model.id) || ungroupedIds.has(model.id))
    const existing = candidates.filter((model) => selected.has(model.id))
    const unmapped = candidates.filter((model) => !selected.has(model.id))
    return [
      ...(existing.length ? [{ type: "heading" as const, id: "heading-existing", label: "Existing Models", count: existing.length }, ...existing.map((model) => ({ type: "model" as const, id: model.id, model }))] : []),
      ...(unmapped.length ? [{ type: "heading" as const, id: "heading-unmapped", label: "Unmapped Models", count: unmapped.length }, ...unmapped.map((model) => ({ type: "model" as const, id: model.id, model }))] : []),
    ]
  }, [data, editingGroup, selectedModels])
  useEffect(() => {
    if (!canonicalPopoverOpen) return
    const timer = setTimeout(() => setCanonicalDebouncedSearch(canonicalSearch.trim()), 250)
    return () => clearTimeout(timer)
  }, [canonicalPopoverOpen, canonicalSearch])
  useEffect(() => {
    if (!canonicalPopoverOpen) return
    const controller = new AbortController()
    const query = new URLSearchParams({ catalog: "models.dev", q: canonicalDebouncedSearch, limit: "100" })
    void apiFetch<CanonicalModelsResponse>(`/api/admin/model-pricing?${query}`, { signal: controller.signal })
      .then((result) => setCanonicalModels(Array.isArray(result.models) ? result.models : []))
      .catch((error) => { if (!controller.signal.aborted) setCanonicalError(error instanceof Error ? error.message : "Unable to load canonical models") })
      .finally(() => { if (!controller.signal.aborted) setCanonicalLoading(false) })
    return () => controller.abort()
  }, [canonicalDebouncedSearch, canonicalPopoverOpen])
  if (!data) return <DashboardContentSkeleton variant="model-pricing" />

  return <Panel title="Model pricing" description="Group compatible gateway models, version their rates, and optionally apply a replacement rate to all stored usage." icon={<DollarSignIcon />} refresh={() => void refreshGroups()} loading={isValidating || pending}>
    {data.ungroupedModels.length > 0 && <Alert variant="default"><AlertTriangleIcon /><AlertTitle>{data.ungroupedModels.length} model{data.ungroupedModels.length === 1 ? " is" : "s are"} not priced</AlertTitle><AlertDescription>Requests for ungrouped models remain visible but cannot be charged to budgets until assigned to a pricing group.</AlertDescription></Alert>}
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="font-medium">Model groups</div><div className="text-sm text-muted-foreground">Fixed groups are refreshed from configured models; custom groups collect models you choose.</div></div><Button size="sm" onClick={() => startGroupEdit("new")}><PlusIcon />New custom group</Button></div>
    <Table><TableHeader><TableRow><TableHead>Group</TableHead><TableHead>Type</TableHead><TableHead>Models</TableHead><TableHead>Current pricing</TableHead><TableHead /></TableRow></TableHeader><TableBody>{data.groups.map((group) => { const members = modelsForGroup(group); const contextTiers = Array.isArray(group.currentVersion?.contextTiers) ? group.currentVersion.contextTiers : []; const canDelete = group.kind === "custom" || members.length === 0; return <TableRow key={group.id}><TableCell><div className="font-medium">{group.name}</div><div className="text-xs text-muted-foreground">{group.currentVersion ? `v${group.currentVersion.version} active ${formatAppDate(group.currentVersion.effectiveAt)}` : "No version configured"}</div>{(group.canonicalModel || group.canonicalModelId) && <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground"><span className="shrink-0">{canonicalSourceLabel(group.canonicalSource || "custom")}</span><span className="truncate">{group.canonicalModel?.name || group.canonicalModelId}</span></div>}</TableCell><TableCell><Badge variant={group.kind === "fixed" ? "outline" : "secondary"}>{group.kind === "fixed" ? "Fixed" : "Custom"}</Badge></TableCell><TableCell><div className="font-medium tabular-nums">{members.length}</div><div className="text-xs text-muted-foreground">{members.slice(0, 2).map((model) => model.gatewayModelId).join(", ")}{members.length > 2 ? ` +${members.length - 2}` : ""}</div></TableCell><TableCell>{group.currentVersion ? <div><div className="font-medium">{formatRate(group.currentVersion.inputMicrosPerMillion)} input</div><div className="text-xs text-muted-foreground">{contextTiers.length ? `${contextTiers.length} context override${contextTiers.length === 1 ? "" : "s"}` : "Standard context"}</div></div> : <Badge variant="destructive">Missing</Badge>}</TableCell><TableCell className="text-right"><div className="flex flex-wrap justify-end gap-2"><Button size="sm" variant="outline" onClick={() => startGroupEdit(group.id)}><PencilIcon />Models</Button><Button size="sm" onClick={() => startPricingEdit(group.id)}>Pricing</Button>{canDelete && <ConfirmAction buttonLabel="Delete" title={`Delete ${group.name}?`} description={group.kind === "custom" ? "Models will become ungrouped and can be assigned again." : "This empty fixed group will be removed."} pending={pending} disabled={pending} onConfirm={() => deleteGroup(group.id)} />}</div></TableCell></TableRow> })}{!data.groups.length && <EmptyRow label="No model groups found. Refresh to scan configured models." colSpan={5} />}</TableBody></Table>
    {data.jobs.length > 0 && <div className="space-y-3 rounded-lg border p-4"><div><div className="font-medium">Repricing history</div><div className="text-sm text-muted-foreground">Replacing a current version recalculates historical events in the background.</div></div>{data.jobs.slice(0, 5).map((job) => <div key={job.id} className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between"><span>{groupById(job.groupId)?.name || "Model group"}</span><span className="text-muted-foreground">{job.status} {job.totalEvents ? `${job.processedEvents}/${job.totalEvents}` : ""}</span></div>)}</div>}
    <Dialog open={Boolean(groupDialog)} onOpenChange={(open) => { if (!open && !pending) setGroupDialog(undefined) }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{groupDialog === "new" ? "Create custom model group" : `Edit ${editingGroup?.name || "model group"}`}</DialogTitle>
          <DialogDescription>{groupDialog === "new" ? "Choose models to keep one shared pricing history." : "Choose which configured models belong to this group."}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-4 md:min-h-[min(24rem,calc(100svh-15rem))] md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="flex h-72 min-h-0 flex-col gap-2 md:h-full">
            <div className="text-sm font-medium">Models in group</div>
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border">
              {modelSelectionRows.length ? <LegendList<ModelSelectionRow> data={modelSelectionRows} keyExtractor={(row) => row.id} estimatedItemSize={52} className="h-full overscroll-y-contain px-2 py-2 outline-none [&>div]:!block [&>div]:!min-w-0 [&>div]:!w-full" renderItem={({ item }) => item.type === "heading" ? <div className="flex items-center justify-between px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground first:pt-1"><span>{item.label}</span><span>{item.count}</span></div> : <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted"><Checkbox checked={selectedModels.includes(item.model.id)} onCheckedChange={() => toggleModel(item.model.id)} /><span className="min-w-0"><span className="block truncate text-sm font-medium">{item.model.name}</span><span className="block truncate text-xs text-muted-foreground">{item.model.gatewayModelId}</span></span></label>} /> : <p className="p-3 text-sm text-muted-foreground">No available models.</p>}
            </div>
          </div>
          <div className="flex min-h-full flex-col gap-4">
            <div className="space-y-2"><label htmlFor="pricing-group-name" className="block text-sm font-medium">Group name</label><Input id="pricing-group-name" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Group name" /></div>
            <div className="space-y-2">
              <div className="text-sm font-medium">Canonical upstream</div>
              <div className="text-xs text-muted-foreground">Link this group to shared model metadata and catalog pricing.</div>
              <div className="space-y-2">
                <Popover open={canonicalPopoverOpen} onOpenChange={(open) => { setCanonicalPopoverOpen(open); if (open) { setCanonicalLoading(true); setCanonicalError(null); setCanonicalDebouncedSearch(canonicalSearch.trim()) } }}>
                  <PopoverTrigger render={<Button variant="outline" size="picker"
                          className="min-h-10 w-full justify-between text-left" disabled={pending}><span className="min-w-0"><span className="block truncate font-medium">{canonicalModel?.name || canonicalModelId || "Select canonical model"}</span><span className="block truncate text-xs text-muted-foreground">{canonicalModel?.id || "Search model ID, name, or provider"}</span></span><ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" /></Button>} />
                  <PopoverContent side="bottom" align="start" sideOffset={6} padding="none"
                      className="w-(--anchor-width) min-w-0 max-w-[calc(100vw-2rem)] overflow-hidden">
                  <div className="flex h-72 max-h-[calc(100vh-8rem)] min-h-0">
                    <Command variant="embedded"
                          className="min-h-0 flex-1" shouldFilter={false}>
                      <CommandInput placeholder="Search model ID, name, or provider..." value={canonicalSearch} onValueChange={(value) => { setCanonicalSearch(value); setCanonicalLoading(true); setCanonicalError(null) }} />
                      <CommandList variant="padded" className="max-h-none min-h-0 flex-1 overscroll-contain overflow-y-auto">
                        <CommandItem value="clear-canonical" onSelect={() => { setCanonicalModelId(""); setCanonicalModel(null); setCanonicalSearch(""); setCanonicalPopoverOpen(false) }}>Clear canonical link</CommandItem>
                        {canonicalLoading ? <div className="space-y-2 p-3">{Array.from({ length: 2 }, (_, index) => <div key={index} className="space-y-2 rounded-md px-3 py-2"><Skeleton className="h-4 w-40 max-w-full" /><Skeleton className="h-3 w-56 max-w-full" /></div>)}</div> : canonicalError ? <CommandEmpty>{canonicalError}</CommandEmpty> : canonicalModels.length === 0 ? <CommandEmpty>{canonicalSearch.trim() ? `No canonical models matched "${canonicalSearch.trim()}".` : "No canonical models available."}</CommandEmpty> : <CommandGroup heading={"Canonical models (" + canonicalModels.length + ")"} variant="flush">{canonicalModels.map((item) => <CommandItem key={item.id} value={item.name + " " + item.id + " " + item.provider} variant="detail" onSelect={() => { setCanonicalModelId(item.id); setCanonicalModel(item); setGroupName(item.name); setCanonicalSearch(""); setCanonicalPopoverOpen(false) }}><div className="min-w-0 flex-1"><div className="truncate font-medium">{item.name}</div><div className="truncate text-xs text-muted-foreground">{item.id} · {item.provider}</div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-caption text-muted-foreground"><span>Input {formatCanonicalRate(item.pricing.inputMicrosPerMillion)}</span><span>Output {formatCanonicalRate(item.pricing.outputMicrosPerMillion)}</span><span>Cache read {formatCanonicalRate(item.pricing.cacheReadMicrosPerMillion)}</span></div></div>{canonicalModelId === item.id && <CheckIcon className="mt-1 size-4 text-primary" />}</CommandItem>)}</CommandGroup>}
                      </CommandList>
                    </Command>
                  </div>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
            {canonicalModel && <div className="flex-1 rounded-lg border bg-muted/20 p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate text-sm font-medium">{canonicalModel.name}</div><div className="truncate text-xs text-muted-foreground">{canonicalModel.id} · {canonicalModel.provider}</div></div><Badge variant="secondary">models.dev</Badge></div><div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"><div><div className="text-muted-foreground">Input</div><div className="font-medium">{formatCanonicalRate(canonicalModel.pricing.inputMicrosPerMillion)}</div></div><div><div className="text-muted-foreground">Output</div><div className="font-medium">{formatCanonicalRate(canonicalModel.pricing.outputMicrosPerMillion)}</div></div><div><div className="text-muted-foreground">Cache read</div><div className="font-medium">{formatCanonicalRate(canonicalModel.pricing.cacheReadMicrosPerMillion)}</div></div><div><div className="text-muted-foreground">Cache creation</div><div className="font-medium">{formatCanonicalRate(canonicalModel.pricing.cacheCreationMicrosPerMillion)}</div></div></div>{canonicalModel.contextLimit && <div className="mt-2 text-xs text-muted-foreground">Context limit: {canonicalModel.contextLimit.toLocaleString()} tokens</div>}</div>}
          </div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setGroupDialog(undefined)} disabled={pending}>Cancel</Button><Button onClick={() => void saveGroup()} disabled={pending || (groupDialog === "new" && !groupName.trim())}>{pending && <LoadingSpinner />}Save group</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(pricingDialog)} onOpenChange={(open) => { if (!open && !pending) setPricingDialog(undefined) }}><DialogContent className="max-w-4xl"><DialogHeader><DialogTitle>Pricing for {groupById(pricingDialog || "")?.name}</DialogTitle><DialogDescription>Set USD rates per million tokens. Context tiers override the standard rates when the input threshold is reached.</DialogDescription></DialogHeader><div className="grid gap-3 sm:grid-cols-2">{rateFields.map(([field, label]) => <label key={field} className="space-y-2 text-sm font-medium"><span className="block">{label}</span><div className="flex h-10 items-center rounded-md border bg-background"><span className="flex h-full items-center border-r px-3 text-muted-foreground">$</span><Input type="number" min="0" step="any" inputMode="decimal" value={rateDrafts[field]} onChange={(event) => { const value = event.target.value; setRateDrafts((current) => ({ ...current, [field]: sanitizeNonNegativeDraft(value) })); setRates((current) => ({ ...current, [field]: parseDollarInput(sanitizeNonNegativeDraft(value)) })) }} variant="inline"
                    className="h-full" /></div></label>)}</div><div className="space-y-3 overflow-hidden rounded-lg border p-3"><div className="flex items-center justify-between"><div><div className="text-sm font-medium">Context pricing</div><div className="text-xs text-muted-foreground">Add a higher-context threshold when the provider charges different rates.</div></div><Button size="sm" variant="outline" onClick={() => { const tier = { id: crypto.randomUUID(), thresholdTokens: 32000, ...rates }; setContextTiers((current) => [...current, tier]); setTierRateDrafts((current) => ({ ...current, [tier.id]: Object.fromEntries(rateFields.map(([field]) => [field, rateDrafts[field]])) })) }}><PlusIcon />Add tier</Button></div><div className="overflow-x-auto pb-1">{contextTiers.map((tier, index) => <div key={tier.id} className="grid min-w-[48rem] gap-3 rounded-md bg-muted/30 p-3 md:grid-cols-[minmax(7rem,1.1fr)_repeat(4,minmax(7rem,1fr))_auto]"><label className="flex min-w-0 flex-col gap-2 text-xs font-medium"><span className="flex min-h-8 items-end leading-4">Threshold</span><Input type="number" min="1" step="1" value={tier.thresholdTokens} onChange={(event) => setContextTiers((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, thresholdTokens: Number(event.target.value) } : entry))} /></label>{rateFields.map(([field, label]) => <label key={field} className="flex min-w-0 flex-col gap-2 text-xs font-medium"><span className="flex min-h-8 items-end leading-4">{label}</span><div className="flex h-10 items-center rounded-md border bg-background"><span className="flex h-full items-center border-r px-2 text-muted-foreground">$</span><Input type="number" min="0" step="any" inputMode="decimal" value={tierRateDrafts[tier.id]?.[field] ?? formatDollarInput(tier[field])} onChange={(event) => { const value = event.target.value; setTierRateDrafts((current) => ({ ...current, [tier.id]: { ...current[tier.id], [field]: sanitizeNonNegativeDraft(value) } })); setContextTiers((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, [field]: parseDollarInput(sanitizeNonNegativeDraft(value)) } : entry)) }} variant="inline"
                          inset="compact"
                          className="h-full min-w-0" /></div></label>)}<Button variant="ghost" size="sm" className="h-10 self-end" onClick={() => { setContextTiers((current) => current.filter((_, entryIndex) => entryIndex !== index)); setTierRateDrafts((current) => { const next = { ...current }; delete next[tier.id]; return next }) }}>Remove</Button></div>)}</div></div><DialogFooter><Button variant="outline" onClick={() => setPricingDialog(undefined)} disabled={pending}>Cancel</Button><Button variant="outline" onClick={() => setReplaceOpen(true)} disabled={pending || !groupById(pricingDialog || "")?.currentVersion}>{pending && <LoadingSpinner />}Replace current version</Button><Button onClick={() => void saveVersion("new")} disabled={pending}>{pending && <LoadingSpinner />}Save as new version</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={replaceOpen} onOpenChange={setReplaceOpen}><DialogContent><DialogHeader><DialogTitle>Reprice historical usage?</DialogTitle><DialogDescription>This replaces the active version and applies its rates to every stored request in this group. Requests without recorded token usage remain unpriced.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setReplaceOpen(false)} disabled={pending}>Cancel</Button><Button variant="destructive" onClick={() => void saveVersion("replace")} disabled={pending}>{pending && <LoadingSpinner />}Replace and reprice</Button></DialogFooter></DialogContent></Dialog>
  </Panel>
}
