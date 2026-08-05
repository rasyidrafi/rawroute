"use client"

import { useMemo, useState } from "react"
import { addDays, format, startOfDay } from "date-fns"
import type { DateRange } from "react-day-picker"
import { CalendarDaysIcon, Clock3Icon, DollarSignIcon, Link2Icon, RefreshCwIcon, RotateCcwIcon, SparklesIcon, WalletCardsIcon } from "lucide-react"
import { toast } from "sonner"
import useSWR from "swr"

import { apiDelete, apiPatch, apiPost, fetcher } from "@/components/dashboard/api"
import { ConfirmAction, EmptyRow } from "@/components/dashboard/shared"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { LoadingSpinner } from "@/components/loading-spinner"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress, ProgressLabel } from "@/components/ui/progress"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { BudgetWindowAnchor } from "@/lib/types"

const money = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`
type BudgetWindowResponse = { start: string; end: string; anchor?: BudgetWindowAnchor; codexAccountId?: string | null; bypassLimits: boolean }
type BudgetEntry = { apiKeyId: string; name: string; weeklyLimitMicros: number; spentMicros: number; enabled: boolean }
type BudgetBypassSession = { id: string; startedAt: string; endedAt: string | null }
type BudgetsResponse = { budgets: BudgetEntry[]; bypassSessions: BudgetBypassSession[]; window: BudgetWindowResponse }
type CodexAccountOption = { id: string; name: string; planType?: string }
type CodexAccountsResponse = { accounts: CodexAccountOption[] }
type BudgetSortKey = "limit" | "usage" | "name"

const budgetSortOptions = [{ value: "limit", label: "Highest limit first" }, { value: "usage", label: "Highest usage first" }, { value: "name", label: "API key name" }] as const
const budgetSortLabel = (value: BudgetSortKey) => budgetSortOptions.find((option) => option.value === value)?.label || budgetSortOptions[0].label
const formatWindowDate = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value))
const formatSessionDate = (value: string | null) => value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Active"
function formatSessionDuration(startedAt: string, endedAt: string | null) { const seconds = Math.max(0, Math.floor(((endedAt ? Date.parse(endedAt) : Date.now()) - Date.parse(startedAt)) / 1000)); const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60); if (days) return `${days}d ${hours}h`; if (hours) return `${hours}h ${minutes}m`; return `${Math.max(1, minutes)}m` }
function formatBudgetResetIn(end: string) { const seconds = Math.max(0, Math.ceil((Date.parse(end) - Date.now()) / 1000)); if (seconds <= 0) return "Now"; const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.max(1, Math.ceil(seconds / 60)); if (days) return hours ? `${days}d ${hours}h` : `${days}d`; return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m` }
function dateToUtcDay(value: Date) { return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())).toISOString() }

export function BudgetsView() {
  const { data, mutate, isLoading, isValidating } = useSWR<BudgetsResponse>("/api/admin/budgets", fetcher)
  const { data: keys } = useSWR<{ apiKeys: Array<{ id: string; name: string }> }>("/api/admin/endpoint-key", fetcher)
  const { data: codexData } = useSWR<CodexAccountsResponse>("/api/admin/oauth-providers", fetcher)
  const [apiKeyId, setApiKeyId] = useState("")
  const [limit, setLimit] = useState("50")
  const [sortBy, setSortBy] = useState<BudgetSortKey>("usage")
  const [windowAnchorOverride, setWindowAnchorOverride] = useState<BudgetWindowAnchor | null>(null)
  const [codexAccountOverride, setCodexAccountOverride] = useState<string | null>(null)
  const [customRangeOverride, setCustomRangeOverride] = useState<DateRange | null>(null)
  const [windowOpen, setWindowOpen] = useState(false)
  const [editingBudgetId, setEditingBudgetId] = useState<string | null>(null)
  const [editLimitValue, setEditLimitValue] = useState("")
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const codexAccounts = codexData?.accounts || []
  const windowAnchor = windowAnchorOverride ?? data?.window.anchor ?? "custom"
  const codexAccountId = codexAccountOverride ?? data?.window.codexAccountId ?? codexAccounts[0]?.id ?? ""
  const customRange = customRangeOverride ?? (data ? { from: new Date(data.window.start), to: new Date(data.window.end) } : undefined)
  const bypass = data?.window.bypassLimits ?? false
  const isPending = (key: string) => pending.has(key)
  const sortedBudgets = useMemo(() => [...(data?.budgets || [])].sort((a, b) => {
    if (sortBy === "limit") return b.weeklyLimitMicros - a.weeklyLimitMicros
    if (sortBy === "name") return a.name.localeCompare(b.name)
    const aUsage = a.weeklyLimitMicros > 0 ? a.spentMicros / a.weeklyLimitMicros : 0
    const bUsage = b.weeklyLimitMicros > 0 ? b.spentMicros / b.weeklyLimitMicros : 0
    return bUsage - aUsage
  }), [data?.budgets, sortBy])

  async function create() {
    if (!apiKeyId) return
    const pendingKey = "create-budget"
    setPending((current) => new Set(current).add(pendingKey))
    try { await apiPost("/api/admin/budgets", { apiKeyId, weeklyLimitUsd: Number(limit) }); setApiKeyId(""); await mutate() }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to create budget") }
    finally { setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next }) }
  }

  async function remove(id: string) {
    const pendingKey = `delete-budget:${id}`
    setPending((current) => new Set(current).add(pendingKey))
    try { await apiDelete(`/api/admin/budgets/${id}`); await mutate(); return true }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to delete budget"); return false }
    finally { setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next }) }
  }

  async function toggle(id: string, enabled: boolean, current: number) {
    const pendingKey = `toggle-budget:${id}`
    setPending((currentPending) => new Set(currentPending).add(pendingKey))
    try { await apiPatch(`/api/admin/budgets/${id}`, { weeklyLimitUsd: current / 1_000_000, enabled }); await mutate() }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to update budget") }
    finally { setPending((currentPending) => { const next = new Set(currentPending); next.delete(pendingKey); return next }) }
  }

  async function updateLimit(id: string, weeklyLimitUsd: number, enabled: boolean) {
    const pendingKey = `update-limit:${id}`
    setPending((current) => new Set(current).add(pendingKey))
    try { await apiPatch(`/api/admin/budgets/${id}`, { weeklyLimitUsd, enabled }); await mutate(); setEditingBudgetId(null); toast.success("Budget limit updated") }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to update budget limit") }
    finally { setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next }) }
  }

  async function toggleBypass(enabled: boolean) {
    const pendingKey = "toggle-bypass"
    setPending((current) => new Set(current).add(pendingKey))
    try { await apiPatch("/api/admin/budgets/bypass", { enabled }); await mutate() }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to update Unlimited Mode") }
    finally { setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next }) }
  }

  async function saveWindow() {
    const pendingKey = "budget-window"
    if (windowAnchor === "codex" && !codexAccountId) { toast.error("Choose a Codex account to sync the budget window."); return }
    if (windowAnchor === "custom" && (!customRange?.from || !customRange.to || customRange.to <= customRange.from)) { toast.error("Choose a valid custom budget range."); return }
    setPending((current) => new Set(current).add(pendingKey))
    try {
      const body = windowAnchor === "codex" ? { anchor: "codex", codexAccountId } : { anchor: "custom", start: dateToUtcDay(customRange!.from!), end: dateToUtcDay(customRange!.to!) }
      await apiPatch("/api/admin/budgets/window", body)
      await mutate()
      setWindowAnchorOverride(null)
      setCodexAccountOverride(null)
      setCustomRangeOverride(null)
      setWindowOpen(false)
      toast.success(windowAnchor === "codex" ? "Budget window synced to Codex" : "Custom budget window saved")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to update budget window") }
    finally { setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next }) }
  }

  if (isLoading || !data || !keys || !codexData) return <DashboardContentSkeleton variant="budgets" />
  const currentAnchor = data.window.anchor || "custom"
  const customRangeValid = Boolean(customRange?.from && customRange.to && customRange.to > customRange.from)
  const minCustomDate = addDays(startOfDay(new Date()), -7)
  const maxCustomDate = customRange?.from ? addDays(customRange.from, 7) : undefined

  return <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8"><div className="mx-auto flex max-w-7xl flex-col gap-6">
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Clock3Icon className="size-5" />Budget window</CardTitle><CardDescription>Choose the shared accounting window used by every gateway key.</CardDescription></CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div className="w-full max-w-sm flex-none"><div className="flex min-h-9 min-w-0 flex-col justify-center rounded-md border bg-muted/35 px-3 py-1.5"><div className="flex items-center justify-between gap-3"><span className="truncate text-sm tabular-nums">{formatWindowDate(data.window.start)} - {formatWindowDate(data.window.end)}</span><Badge variant="outline" className="shrink-0 gap-1">{currentAnchor === "codex" ? <><Link2Icon className="size-3" />Codex synced</> : "Custom range"}</Badge></div><span className="text-xs text-muted-foreground">{currentAnchor === "codex" ? `Resets in ${formatBudgetResetIn(data.window.end)}; refreshed every 5 minutes` : "Manual date range; budget usage resets at the selected end date"}</span></div></div><div className="flex flex-col gap-3 sm:flex-row sm:items-end lg:ml-auto"><div className="flex w-full flex-col gap-2 sm:w-auto"><span className="text-sm font-medium">Window anchor</span><Select value={windowAnchor} onValueChange={(value) => { if (!value) return; const next = value as BudgetWindowAnchor; setWindowAnchorOverride(next); if (next === "codex" && !codexAccountId) setCodexAccountOverride(codexAccounts[0]?.id || "") }} disabled={isPending("budget-window")}><SelectTrigger className="min-w-48"><span>{windowAnchor === "codex" ? "Sync Codex account" : "Custom date range"}</span></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Budget window</SelectLabel><SelectItem value="codex" disabled={!codexAccounts.length}>Sync Codex account{!codexAccounts.length ? " (no accounts)" : ""}</SelectItem><SelectItem value="custom">Custom date range</SelectItem></SelectGroup></SelectContent></Select></div>{windowAnchor === "codex" ? <div className="flex w-full flex-col gap-2 sm:w-auto"><span className="text-sm font-medium">Codex account</span><Select value={codexAccountId} onValueChange={(value) => setCodexAccountOverride(value || "")} disabled={!codexAccounts.length || isPending("budget-window")}><SelectTrigger className="min-w-48"><SelectValue placeholder="Select account" /></SelectTrigger><SelectContent>{codexAccounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>)}</SelectContent></Select></div> : <Popover open={windowOpen} onOpenChange={setWindowOpen}><PopoverTrigger render={<Button variant="outline" disabled={isPending("budget-window")}><CalendarDaysIcon />{customRange?.from ? `${format(customRange.from, "MMM d")} - ${customRange.to ? format(customRange.to, "MMM d") : "Choose end"}` : "Choose dates"}</Button>} /><PopoverContent className="w-auto p-0" align="end"><Calendar mode="range" selected={customRange} defaultMonth={customRange?.from} onSelect={(next) => setCustomRangeOverride(next || null)} disabled={maxCustomDate ? { before: minCustomDate, after: maxCustomDate } : { before: minCustomDate }} numberOfMonths={1} initialFocus /><div className="flex justify-end gap-2 border-t p-3"><Button variant="outline" size="sm" onClick={() => { setCustomRangeOverride({ from: new Date(data.window.start), to: new Date(data.window.end) }); setWindowOpen(false) }}>Cancel</Button><Button size="sm" disabled={!customRangeValid} onClick={() => setWindowOpen(false)}>Apply</Button></div></PopoverContent></Popover>}<Button aria-busy={isPending("budget-window")} disabled={isPending("budget-window") || (windowAnchor === "codex" ? !codexAccountId : !customRangeValid)} onClick={() => void saveWindow()}>{isPending("budget-window") && <LoadingSpinner />}Save window</Button></div></div>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><WalletCardsIcon className="size-5" />Budgets</CardTitle><CardDescription>Weekly USD limits for gateway API keys. Existing keys remain unlimited until configured.</CardDescription><CardAction><Button aria-busy={isValidating} variant="outline" onClick={() => void mutate()} disabled={isValidating}>{isValidating ? <LoadingSpinner /> : <RefreshCwIcon />}Refresh</Button></CardAction></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div className="flex flex-col gap-3 sm:flex-row sm:items-end"><Select value={apiKeyId} onValueChange={(value) => setApiKeyId(value || "")}><SelectTrigger className="md:w-64"><SelectValue placeholder="Select gateway key" /></SelectTrigger><SelectContent>{(keys.apiKeys || []).filter((key) => !data.budgets.some((budget) => budget.apiKeyId === key.id)).map((key) => <SelectItem key={key.id} value={key.id}>{key.name}</SelectItem>)}</SelectContent></Select><div className="flex items-center gap-3"><div className="relative md:w-40"><DollarSignIcon aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9 md:w-40" value={limit} onChange={(event) => setLimit(event.target.value)} type="number" min="0.01" step="0.01" placeholder="Weekly USD" /></div><Button aria-busy={isPending("create-budget")} onClick={() => void create()} disabled={isPending("create-budget") || !apiKeyId}>{isPending("create-budget") && <LoadingSpinner />}Create budget</Button></div></div></div>
        <div className="flex items-center justify-between gap-4 rounded-lg border p-4 text-sm"><div><div className="font-medium">Unlimited Mode</div><div className="text-muted-foreground">All gateway keys bypass budget limits until you deactivate it.</div></div><AlertDialog><AlertDialogTrigger render={<Button aria-busy={isPending("toggle-bypass")} variant={bypass ? "default" : "outline"} className={cn("h-9 min-w-40 gap-2 border-border/70", bypass ? "unlimited-button" : "unlimited-button-idle")} disabled={isPending("toggle-bypass")}>{isPending("toggle-bypass") ? <LoadingSpinner /> : <SparklesIcon className="size-4" />}{bypass ? "Deactivate" : "Activate"}</Button>} /><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{bypass ? "Deactivate Unlimited Mode?" : "Activate Unlimited Mode?"}</AlertDialogTitle><AlertDialogDescription>{bypass ? "Budget enforcement will resume immediately for all gateway keys." : "All gateway keys will bypass budget limits until you deactivate Unlimited Mode."}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={isPending("toggle-bypass")}>Cancel</AlertDialogCancel><AlertDialogAction aria-busy={isPending("toggle-bypass")} disabled={isPending("toggle-bypass")} onClick={() => void toggleBypass(!bypass)}>{isPending("toggle-bypass") && <LoadingSpinner />}{bypass ? "Deactivate" : "Activate"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div>
        {data.bypassSessions.length > 0 && <div className="space-y-3 rounded-lg border p-4"><div><div className="font-medium">Unlimited Mode history</div><div className="text-sm text-muted-foreground">Each activation is recorded as its own session.</div></div><Table><TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Ended</TableHead><TableHead>Duration</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{data.bypassSessions.map((session) => <TableRow key={session.id}><TableCell className="text-sm">{formatSessionDate(session.startedAt)}</TableCell><TableCell className="text-sm text-muted-foreground">{formatSessionDate(session.endedAt)}</TableCell><TableCell className="text-sm tabular-nums">{formatSessionDuration(session.startedAt, session.endedAt)}</TableCell><TableCell><Badge variant={session.endedAt ? "outline" : "secondary"}>{session.endedAt ? "Completed" : "Active"}</Badge></TableCell></TableRow>)}</TableBody></Table></div>}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-sm font-medium">Budget usage</div><div className="text-xs text-muted-foreground">Usage is measured across the shared budget window.</div></div><Select value={sortBy} onValueChange={(value) => { if (value) setSortBy(value as BudgetSortKey) }}><SelectTrigger className="min-w-44"><span className="truncate">{budgetSortLabel(sortBy)}</span></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Ordering</SelectLabel>{budgetSortOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select></div>
        <Table><TableHeader><TableRow><TableHead>Key</TableHead><TableHead>Status</TableHead><TableHead>Limit</TableHead><TableHead>Usage</TableHead><TableHead /></TableRow></TableHeader><TableBody>{sortedBudgets.map((budget) => { const toggleKey = `toggle-budget:${budget.apiKeyId}`; const deleteKey = `delete-budget:${budget.apiKeyId}`; const updateKey = `update-limit:${budget.apiKeyId}`; const percentUsed = budget.weeklyLimitMicros > 0 ? budget.spentMicros / budget.weeklyLimitMicros * 100 : 0; const remainingMicros = Math.max(0, budget.weeklyLimitMicros - budget.spentMicros); return <TableRow key={budget.apiKeyId} className="align-top"><TableCell className="font-medium">{budget.name}</TableCell><TableCell className="align-middle"><Badge variant={!budget.enabled ? "outline" : budget.spentMicros >= budget.weeklyLimitMicros ? "destructive" : "secondary"}>{!budget.enabled ? "Disabled" : budget.spentMicros >= budget.weeklyLimitMicros ? "Exceeded" : "Active"}</Badge></TableCell><TableCell className="align-middle tabular-nums">{bypass ? <span className="unlimited-shine inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-sm font-semibold tabular-nums"><span className="font-mono">∞</span><span>Unlimited</span></span> : money(budget.weeklyLimitMicros)}</TableCell><TableCell className="min-w-52"><div className="space-y-2"><div className="flex items-center justify-between gap-3"><span className="text-xs font-medium text-muted-foreground">{bypass ? `Usage since ${formatWindowDate(data.window.start)}` : `${money(budget.spentMicros)} / ${money(budget.weeklyLimitMicros)}`}</span>{bypass ? <span className="unlimited-shine inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold tabular-nums"><span className="font-mono">∞</span><span>Unlimited</span></span> : <span className="text-xs text-muted-foreground tabular-nums">{Math.round(percentUsed)}%</span>}</div><Progress value={bypass ? 100 : Math.min(percentUsed, 100)} className={bypass ? "unlimited-progress" : undefined}><ProgressLabel className="sr-only">Budget usage</ProgressLabel></Progress><div className="text-xs text-muted-foreground">{bypass ? "Unlimited Usage" : `${money(remainingMicros)} remaining`}</div></div></TableCell><TableCell className="align-middle text-right"><div className="flex flex-wrap justify-end gap-2"><Button aria-busy={isPending(toggleKey)} size="sm" variant="outline" disabled={isPending(toggleKey) || isPending(deleteKey) || isPending(updateKey)} onClick={() => void toggle(budget.apiKeyId, !budget.enabled, budget.weeklyLimitMicros)}>{isPending(toggleKey) && <LoadingSpinner />}{budget.enabled ? "Disable" : "Enable"}</Button><Popover open={editingBudgetId === budget.apiKeyId} onOpenChange={(open) => { if (open) { setEditingBudgetId(budget.apiKeyId); setEditLimitValue((budget.weeklyLimitMicros / 1_000_000).toFixed(2)) } else if (!isPending(updateKey)) setEditingBudgetId(null) }}><PopoverTrigger render={<Button size="sm" variant="outline" disabled={isPending(toggleKey) || isPending(deleteKey) || isPending(updateKey)}>Limit</Button>} /><PopoverContent className="w-auto p-3" align="end"><div className="flex flex-col gap-2"><label htmlFor={`budget-limit-${budget.apiKeyId}`} className="text-sm font-medium">Edit Limit ($)</label><div className="flex items-center gap-2"><div className="relative"><DollarSignIcon aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input id={`budget-limit-${budget.apiKeyId}`} type="number" value={editLimitValue} onChange={(event) => setEditLimitValue(event.target.value)} min="0.01" step="0.01" className="h-8 w-28 pl-7" /></div><Button aria-busy={isPending(updateKey)} size="sm" disabled={isPending(updateKey) || Number(editLimitValue) <= 0} onClick={() => void updateLimit(budget.apiKeyId, Number(editLimitValue), budget.enabled)}>{isPending(updateKey) && <LoadingSpinner />}Save</Button></div></div></PopoverContent></Popover><ConfirmAction buttonLabel="Delete" title={`Delete ${budget.name}?`} description="This permanently deletes the budget configuration for this gateway key." pending={isPending(deleteKey)} disabled={isPending(deleteKey) || isPending(toggleKey) || isPending(updateKey)} onConfirm={() => remove(budget.apiKeyId)} /></div></TableCell></TableRow> })}{!sortedBudgets.length && <EmptyRow label="No budgets configured yet." colSpan={5} />}</TableBody></Table>
      </CardContent>
    </Card>
  </div></main>
}

export function ModelPricingView() {
  const { data: pricing, mutate, isValidating } = useSWR<{ pricing: Array<Record<string, unknown>> }>("/api/admin/model-pricing", fetcher)
  const { data: models } = useSWR<{ models: Array<{ id: string; gatewayModelId: string; providerId: string; upstreamModel: string }> }>("/api/admin/model-pricing/models", fetcher)
  const [modelId, setModelId] = useState("")
  const [input, setInput] = useState("0")
  const [output, setOutput] = useState("0")
  const [cacheRead, setCacheRead] = useState("0")
  const [cacheCreation, setCacheCreation] = useState("0")
  const [pending, setPending] = useState(false)
  const selected = models?.models.find((model) => model.id === modelId)

  async function save() {
    if (!selected) return
    setPending(true)
    try { await apiPost("/api/admin/model-pricing", { modelId: selected.id, provider: selected.providerId, gatewayModelId: selected.gatewayModelId, upstreamModel: selected.upstreamModel, inputMicrosPerMillion: Number(input), outputMicrosPerMillion: Number(output), cacheReadMicrosPerMillion: Number(cacheRead), cacheCreationMicrosPerMillion: Number(cacheCreation), enabled: true }); await mutate() }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to save model pricing") }
    finally { setPending(false) }
  }

  if (!pricing || !models) return <DashboardContentSkeleton variant="model-pricing" />
  return <Panel title="Model pricing" description="Rates are stored as integer micros per million tokens and attach to canonical Rawroute models." icon={<DollarSignIcon />} refresh={() => void mutate()} loading={isValidating}><div className="grid gap-3 rounded-lg border bg-muted/20 p-4 md:grid-cols-2 xl:grid-cols-6"><Select value={modelId} onValueChange={(value) => setModelId(value || "")}><SelectTrigger className="xl:col-span-2"><SelectValue placeholder="Canonical model" /></SelectTrigger><SelectContent>{models.models.map((model) => <SelectItem key={model.id} value={model.id}>{model.gatewayModelId}</SelectItem>)}</SelectContent></Select><Input value={input} onChange={(event) => setInput(event.target.value)} type="number" placeholder="Input micros" /><Input value={output} onChange={(event) => setOutput(event.target.value)} type="number" placeholder="Output micros" /><Input value={cacheRead} onChange={(event) => setCacheRead(event.target.value)} type="number" placeholder="Cache-read micros" /><Input value={cacheCreation} onChange={(event) => setCacheCreation(event.target.value)} type="number" placeholder="Cache-create micros" /><Button aria-busy={pending} onClick={() => void save()} disabled={!selected || pending}>{pending && <LoadingSpinner />}Save</Button></div><Table><TableHeader><TableRow><TableHead>Gateway model</TableHead><TableHead>Provider</TableHead><TableHead>Upstream</TableHead><TableHead>Input</TableHead><TableHead>Output</TableHead><TableHead>State</TableHead></TableRow></TableHeader><TableBody>{pricing.pricing.map((entry) => <TableRow key={String(entry.id)}><TableCell className="font-medium">{String(entry.gatewayModelId)}</TableCell><TableCell>{String(entry.provider)}</TableCell><TableCell>{String(entry.upstreamModel)}</TableCell><TableCell>{String(entry.inputMicrosPerMillion)}</TableCell><TableCell>{String(entry.outputMicrosPerMillion)}</TableCell><TableCell><Badge variant={entry.enabled ? "secondary" : "outline"}>{entry.enabled ? "Enabled" : "Disabled"}</Badge></TableCell></TableRow>)}{!pricing.pricing.length && <EmptyRow label="No model pricing configured yet." colSpan={6} />}</TableBody></Table></Panel>
}

type LimitAccount = { id: string; name: string; email?: string; enabled: boolean; usage?: { fiveHour: { remainingPercent: number; resetAt?: string } | null; weekly: { remainingPercent: number; resetAt?: string } | null; unusedResetCredits?: number; stale: boolean; error?: string } }
export function LimitsView() {
  const { data, mutate, isLoading, isValidating } = useSWR<{ accounts: LimitAccount[] }>("/api/admin/limits", fetcher)
  const [target, setTarget] = useState<LimitAccount>()
  const [confirmation, setConfirmation] = useState("")
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const isPending = (key: string) => pending.has(key)

  async function toggle(account: LimitAccount) {
    const pendingKey = `toggle-account:${account.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try { await apiPatch(`/api/admin/oauth-providers/${account.id}`, { enabled: !account.enabled }); await mutate() }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to update account") }
    finally { setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next }) }
  }

  async function reset() {
    if (!target) return
    const pendingKey = `reset-account:${target.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try { await apiPost(`/api/admin/oauth-providers/${target.id}/reset`, { confirmation }); setTarget(undefined); setConfirmation(""); await mutate() }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to redeem reset") }
    finally { setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next }) }
  }

  return <Panel title="Codex limits" description="Quota state and banked reset redemption for Codex OAuth accounts." icon={<RotateCcwIcon />} refresh={() => void mutate()} loading={isLoading || isValidating}><Table><TableHeader><TableRow><TableHead>Account</TableHead><TableHead>5-hour</TableHead><TableHead>Weekly</TableHead><TableHead>State</TableHead><TableHead /></TableRow></TableHeader><TableBody>{(data?.accounts || []).map((account) => { const pendingKey = `toggle-account:${account.id}`; return <TableRow key={account.id}><TableCell><div className="font-medium">{account.name}</div><div className="text-xs text-muted-foreground">{account.email || "OAuth account"}</div></TableCell><TableCell>{account.usage?.fiveHour ? `${Math.round(account.usage.fiveHour.remainingPercent)}% left` : "N/A"}</TableCell><TableCell>{account.usage?.weekly ? `${Math.round(account.usage.weekly.remainingPercent)}% left` : "N/A"}</TableCell><TableCell><Badge variant={account.enabled ? "secondary" : "outline"}>{account.enabled ? "Enabled" : "Disabled"}</Badge>{account.usage?.error && <div className="text-xs text-destructive">{account.usage.error}</div>}</TableCell><TableCell className="text-right"><div className="flex justify-end gap-2"><Button aria-busy={isPending(pendingKey)} size="sm" variant="outline" disabled={isPending(pendingKey)} onClick={() => void toggle(account)}>{isPending(pendingKey) && <LoadingSpinner />}{account.enabled ? "Disable" : "Enable"}</Button><Button size="sm" variant="outline" onClick={() => setTarget(account)} disabled={isPending(pendingKey)}><RotateCcwIcon />Reset</Button></div></TableCell></TableRow> })}{!data?.accounts.length && <EmptyRow label="No Codex accounts connected yet." colSpan={5} />}</TableBody></Table><AlertDialog open={Boolean(target)} onOpenChange={(open) => { if (!open && !isPending(`reset-account:${target?.id}`)) setTarget(undefined) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Redeem Codex reset credit?</AlertDialogTitle><AlertDialogDescription>This refreshes quota and requires confirmation containing <code>use my codex reset</code>.</AlertDialogDescription></AlertDialogHeader><Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="use my codex reset" /><AlertDialogFooter><AlertDialogCancel disabled={isPending(`reset-account:${target?.id}`)}>Cancel</AlertDialogCancel><AlertDialogAction aria-busy={isPending(`reset-account:${target?.id}`)} disabled={!confirmation.toLowerCase().includes("use my codex reset") || isPending(`reset-account:${target?.id}`)} onClick={() => void reset()}>{isPending(`reset-account:${target?.id}`) && <LoadingSpinner />}Redeem reset</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></Panel>
}

function Panel({ title, description, icon, refresh, loading, children }: { title: string; description: string; icon: React.ReactNode; refresh: () => void; loading?: boolean; children: React.ReactNode }) { return <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8"><div className="mx-auto flex max-w-7xl flex-col gap-6"><Card><CardHeader><CardTitle className="flex items-center gap-2">{icon}{title}</CardTitle><CardDescription>{description}</CardDescription><CardAction><Button aria-busy={loading} variant="outline" onClick={refresh} disabled={loading}>{loading ? <LoadingSpinner /> : <RefreshCwIcon />}Refresh</Button></CardAction></CardHeader><CardContent className="space-y-4">{children}</CardContent></Card></div></main> }
