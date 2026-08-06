"use client"

import { useEffect, useMemo, useState } from "react"
import { addDays, format } from "date-fns"
import type { DateRange } from "react-day-picker"
import { AlertTriangleIcon, CalendarDaysIcon, ChartNoAxesCombinedIcon, CheckIcon, ChevronsUpDownIcon, Clock3Icon, DollarSignIcon, Link2Icon, PencilIcon, PlusIcon, RefreshCwIcon, RotateCcwIcon, SparklesIcon, WalletCardsIcon } from "lucide-react"
import { LegendList } from "@legendapp/list/react"
import { toast } from "sonner"
import useSWR from "swr"

import { apiDelete, apiFetch, apiPatch, apiPost, fetcher } from "@/components/dashboard/api"
import { ConfirmAction, EmptyRow } from "@/components/dashboard/shared"
import { formatCost } from "@/components/dashboard/usage-utils"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { LoadingSpinner } from "@/components/loading-spinner"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Checkbox } from "@/components/ui/checkbox"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress, ProgressLabel } from "@/components/ui/progress"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { calendarDateFromInstant, formatAppDate, formatAppDateTime, formatAppWindowDate, getZonedParts, zonedDateTimeToDate } from "@/lib/timezone"
import type { BudgetWindowAnchor, CanonicalModelSummary, ModelPricingGroup, ModelPricingVersion, PricingCanonicalSource, PricingContextTier, PricingRates, PricingJob } from "@/lib/types"

const money = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`
type BudgetWindowResponse = { start: string; end: string; anchor?: BudgetWindowAnchor; codexAccountId?: string | null; bypassLimits: boolean }
type BudgetEntry = { apiKeyId: string; name: string; weeklyLimitMicros: number; spentMicros: number; enabled: boolean; usageStartAt?: string; lastUsedAt?: string | null }
type BudgetBypassSession = { id: string; startedAt: string; endedAt: string | null }
type BudgetsResponse = { budgets: BudgetEntry[]; bypassSessions: BudgetBypassSession[]; window: BudgetWindowResponse; apiKeys: Array<{ id: string; name: string }>; codexAccounts: CodexAccountOption[] }
type CodexAccountOption = { id: string; name: string; planType?: string }
type BudgetSortKey = "limit" | "usage" | "name"

const budgetSortOptions = [{ value: "limit", label: "Highest limit first" }, { value: "usage", label: "Highest usage first" }, { value: "name", label: "API key name" }] as const
const TIME_HOURS = Array.from({ length: 24 }, (_, index) => `${index}`.padStart(2, "0"))
const TIME_MINUTES = Array.from({ length: 60 }, (_, index) => `${index}`.padStart(2, "0"))
const budgetSortLabel = (value: BudgetSortKey) => budgetSortOptions.find((option) => option.value === value)?.label || budgetSortOptions[0].label
const formatWindowDate = (value: string) => formatAppWindowDate(value)
const formatSessionDate = (value: string | null) => value ? formatAppDateTime(value) : "Active"
function formatSessionDuration(startedAt: string, endedAt: string | null) { const seconds = Math.max(0, Math.floor(((endedAt ? Date.parse(endedAt) : Date.now()) - Date.parse(startedAt)) / 1000)); const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60); if (days) return `${days}d ${hours}h`; if (hours) return `${hours}h ${minutes}m`; return `${Math.max(1, minutes)}m` }
function formatBudgetResetIn(end: string) { const seconds = Math.max(0, Math.ceil((Date.parse(end) - Date.now()) / 1000)); if (seconds <= 0) return "Now"; const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.max(1, Math.ceil(seconds / 60)); if (days) return hours ? `${days}d ${hours}h` : `${days}d`; return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m` }
function formatWindowTime(value: string) { const parts = getZonedParts(value); return Number.isFinite(parts.hour) ? `${`${parts.hour}`.padStart(2, "0")}:${`${parts.minute}`.padStart(2, "0")}` : "00:00" }
function dateToAppDateTime(value: Date, time: string) { return zonedDateTimeToDate(value, time).toISOString() }
function sanitizeNonNegativeDraft(value: string) { return value.includes("-") ? "0" : value }

export function BudgetsView() {
  const { data, mutate, isLoading, isValidating } = useSWR<BudgetsResponse>("/api/admin/budgets", fetcher)
  const [apiKeyId, setApiKeyId] = useState("")
  const [limit, setLimit] = useState("50")
  const [sortBy, setSortBy] = useState<BudgetSortKey>("limit")
  const [windowAnchorOverride, setWindowAnchorOverride] = useState<BudgetWindowAnchor | null>(null)
  const [codexAccountOverride, setCodexAccountOverride] = useState<string | null>(null)
  const [customRangeOverride, setCustomRangeOverride] = useState<DateRange | null>(null)
  const [customTimeOverride, setCustomTimeOverride] = useState<string | null>(null)
  const [windowOpen, setWindowOpen] = useState(false)
  const [editingBudgetId, setEditingBudgetId] = useState<string | null>(null)
  const [editLimitValue, setEditLimitValue] = useState("")
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const codexAccounts = data?.codexAccounts || []
  const windowAnchor = windowAnchorOverride ?? data?.window.anchor ?? "custom"
  const codexAccountId = codexAccountOverride ?? data?.window.codexAccountId ?? codexAccounts[0]?.id ?? ""
  const customRange = customRangeOverride ?? (data ? { from: calendarDateFromInstant(data.window.start), to: calendarDateFromInstant(data.window.end) } : undefined)
  const customTime = customTimeOverride ?? (data ? formatWindowTime(data.window.start) : "00:00")
  const [customHour, customMinute] = customTime.split(":")
  const bypass = data?.window.bypassLimits ?? false
  const isPending = (key: string) => pending.has(key)
  const totalAllocatedMicros = useMemo(() => (data?.budgets || []).reduce((total, budget) => total + budget.weeklyLimitMicros, 0), [data?.budgets])
  const totalSpentMicros = useMemo(() => (data?.budgets || []).reduce((total, budget) => total + budget.spentMicros, 0), [data?.budgets])
  const totalUsagePercent = totalAllocatedMicros > 0 ? totalSpentMicros / totalAllocatedMicros * 100 : 0
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
    if (windowAnchor === "custom" && (!customRange?.from || !customRange.to || !customTime || dateToAppDateTime(customRange.from, customTime) >= dateToAppDateTime(customRange.to, customTime))) { toast.error("Choose a valid custom budget range."); return }
    setPending((current) => new Set(current).add(pendingKey))
    try {
      const body = windowAnchor === "codex" ? { anchor: "codex", codexAccountId } : { anchor: "custom", start: dateToAppDateTime(customRange!.from!, customTime), end: dateToAppDateTime(customRange!.to!, customTime) }
      await apiPatch("/api/admin/budgets/window", body)
      await mutate()
      setWindowAnchorOverride(null)
      setCodexAccountOverride(null)
      setCustomRangeOverride(null)
      setCustomTimeOverride(null)
      setWindowOpen(false)
      toast.success(windowAnchor === "codex" ? "Budget window synced to Codex" : "Custom budget window saved")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to update budget window") }
    finally { setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next }) }
  }

  if (isLoading || !data) return <DashboardContentSkeleton variant="budgets" />
  const currentAnchor = data.window.anchor || "custom"
  const customRangeValid = Boolean(customRange?.from && customRange.to && dateToAppDateTime(customRange.from, customTime) < dateToAppDateTime(customRange.to, customTime))
  const minCustomDate = addDays(calendarDateFromInstant(new Date()), -7)
  const maxCustomDate = customRange?.from ? addDays(customRange.from, 7) : undefined

  return <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8"><div className="mx-auto flex max-w-7xl flex-col gap-6">
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Clock3Icon className="size-5" />Budget window</CardTitle><CardDescription>Choose the shared accounting window used by every gateway key.</CardDescription></CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div className="w-full max-w-sm flex-none"><div className="flex min-h-9 min-w-0 flex-col justify-center rounded-md border bg-muted/35 px-3 py-1.5"><div className="flex items-center justify-between gap-3"><span className="truncate text-sm tabular-nums">{formatWindowDate(data.window.start)} - {formatWindowDate(data.window.end)}</span><Badge variant="outline" className="shrink-0 gap-1">{currentAnchor === "codex" ? <><Link2Icon className="size-3" />Codex synced</> : "Custom range"}</Badge></div><span className="text-xs text-muted-foreground">{currentAnchor === "codex" ? `Resets in ${formatBudgetResetIn(data.window.end)}; refreshed every 5 minutes` : "Manual date range; budget usage resets at the selected end date"}</span></div></div><div className="flex flex-col gap-3 sm:flex-row sm:items-end lg:ml-auto"><div className="flex w-full flex-col gap-2 sm:w-auto"><span className="text-sm font-medium">Window anchor</span><Select value={windowAnchor} onValueChange={(value) => { if (!value) return; const next = value as BudgetWindowAnchor; setWindowAnchorOverride(next); if (next === "codex" && !codexAccountId) setCodexAccountOverride(codexAccounts[0]?.id || "") }} disabled={isPending("budget-window")}><SelectTrigger className="min-w-48"><span>{windowAnchor === "codex" ? "Sync Codex account" : "Custom date range"}</span></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Budget window</SelectLabel><SelectItem value="codex" disabled={!codexAccounts.length}>Sync Codex account{!codexAccounts.length ? " (no accounts)" : ""}</SelectItem><SelectItem value="custom">Custom date range</SelectItem></SelectGroup></SelectContent></Select></div>{windowAnchor === "codex" ? <div className="flex w-full flex-col gap-2 sm:w-auto"><span className="text-sm font-medium">Codex account</span><Select value={codexAccountId} onValueChange={(value) => setCodexAccountOverride(value || "")} disabled={!codexAccounts.length || isPending("budget-window")}><SelectTrigger className="min-w-48"><SelectValue placeholder="Select account" /></SelectTrigger><SelectContent>{codexAccounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>)}</SelectContent></Select></div> : <Popover open={windowOpen} onOpenChange={setWindowOpen}><PopoverTrigger render={<Button variant="outline" disabled={isPending("budget-window")}><CalendarDaysIcon />{customRange?.from ? format(customRange.from, "MMM d") + ", " + customTime + " - " + (customRange.to ? format(customRange.to, "MMM d") + ", " + customTime : "Choose end") : "Choose dates"}</Button>} /><PopoverContent className="w-auto p-0" align="start"><Calendar mode="range" selected={customRange} defaultMonth={customRange?.from} onSelect={(next) => setCustomRangeOverride(next || null)} disabled={maxCustomDate ? { before: minCustomDate, after: maxCustomDate } : { before: minCustomDate }} numberOfMonths={1} classNames={{ root: "w-full rdp-root" }} autoFocus /><div className="border-t p-3"><div className="flex items-center gap-3"><label htmlFor="budget-window-time" className="text-sm font-medium">Time</label><div className="flex items-center gap-2"><Select value={customHour} onValueChange={(value) => setCustomTimeOverride(value + ":" + customMinute)} disabled={isPending("budget-window")}><SelectTrigger aria-label="Hour"><SelectValue /></SelectTrigger><SelectContent>{TIME_HOURS.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select><span className="text-muted-foreground">:</span><Select value={customMinute} onValueChange={(value) => setCustomTimeOverride(customHour + ":" + value)} disabled={isPending("budget-window")}><SelectTrigger aria-label="Minute"><SelectValue /></SelectTrigger><SelectContent>{TIME_MINUTES.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div></div><p className="mt-2 text-xs text-muted-foreground">Applied to both the start and end dates.</p></div><div className="flex justify-end gap-2 border-t p-3"><Button variant="outline" size="sm" onClick={() => { setCustomRangeOverride({ from: calendarDateFromInstant(data.window.start), to: calendarDateFromInstant(data.window.end) }); setCustomTimeOverride(null); setWindowOpen(false) }}>Cancel</Button><Button size="sm" disabled={!customRangeValid} onClick={() => setWindowOpen(false)}>Apply</Button></div></PopoverContent></Popover>}<Button aria-busy={isPending("budget-window")} disabled={isPending("budget-window") || (windowAnchor === "codex" ? !codexAccountId : !customRangeValid)} onClick={() => void saveWindow()}>{isPending("budget-window") && <LoadingSpinner />}Save window</Button></div></div>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><WalletCardsIcon className="size-5" />Budgets</CardTitle><CardDescription>Weekly USD limits for gateway API keys. Existing keys remain unlimited until configured.</CardDescription><CardAction><Button aria-busy={isValidating} variant="outline" onClick={() => void mutate()} disabled={isValidating}>{isValidating ? <LoadingSpinner /> : <RefreshCwIcon />}Refresh</Button></CardAction></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border bg-muted/20 p-4">
            <div className="flex items-start justify-between gap-3"><div><div className="text-sm font-medium">Total budget allocated</div><div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{money(totalAllocatedMicros)}</div></div><div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><WalletCardsIcon className="size-4" /></div></div>
            <div className="mt-2 text-xs text-muted-foreground">Across {data.budgets.length} configured {data.budgets.length === 1 ? "budget" : "budgets"} in this window</div>
          </div>
          <div className="rounded-xl border bg-muted/20 p-4">
            <div className="flex items-start justify-between gap-3"><div><div className="text-sm font-medium">Total budget used</div><div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{money(totalSpentMicros)}</div></div><div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><ChartNoAxesCombinedIcon className="size-4" /></div></div>
            <div className="mt-3 space-y-2"><Progress value={Math.min(totalUsagePercent, 100)} /><div className="flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>{bypass ? "Unlimited Mode active" : totalAllocatedMicros > 0 ? `${Math.round(totalUsagePercent)}% of allocated budget` : "No budget limits configured"}</span><span className="shrink-0">{formatWindowDate(data.window.start)} - {formatWindowDate(data.window.end)}</span></div></div>
          </div>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div className="flex flex-col gap-3 sm:flex-row sm:items-end"><Select value={apiKeyId} onValueChange={(value) => setApiKeyId(value || "")}><SelectTrigger className="md:w-64"><SelectValue placeholder="Select gateway key" /></SelectTrigger><SelectContent>{data.apiKeys.filter((key) => !data.budgets.some((budget) => budget.apiKeyId === key.id)).map((key) => <SelectItem key={key.id} value={key.id}>{key.name}</SelectItem>)}</SelectContent></Select><div className="flex items-center gap-3"><div className="relative md:w-40"><DollarSignIcon aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9 md:w-40" value={limit} onChange={(event) => setLimit(sanitizeNonNegativeDraft(event.target.value))} type="number" min="0.01" step="0.01" placeholder="Weekly USD" /></div><Button aria-busy={isPending("create-budget")} onClick={() => void create()} disabled={isPending("create-budget") || !apiKeyId}>{isPending("create-budget") && <LoadingSpinner />}Create budget</Button></div></div></div>
        <div className="flex items-center justify-between gap-4 rounded-lg border p-4 text-sm"><div><div className="font-medium">Unlimited Mode</div><div className="text-muted-foreground">All gateway keys bypass budget limits until you deactivate it.</div></div><AlertDialog><AlertDialogTrigger render={<Button aria-busy={isPending("toggle-bypass")} variant={bypass ? "default" : "outline"} className={cn("h-9 min-w-40 gap-2 border-border/70", bypass ? "unlimited-button" : "unlimited-button-idle")} disabled={isPending("toggle-bypass")}>{isPending("toggle-bypass") ? <LoadingSpinner /> : <SparklesIcon className="size-4" />}{bypass ? "Deactivate" : "Activate"}</Button>} /><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{bypass ? "Deactivate Unlimited Mode?" : "Activate Unlimited Mode?"}</AlertDialogTitle><AlertDialogDescription>{bypass ? "Budget enforcement will resume immediately for all gateway keys." : "All gateway keys will bypass budget limits until you deactivate Unlimited Mode."}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={isPending("toggle-bypass")}>Cancel</AlertDialogCancel><AlertDialogAction aria-busy={isPending("toggle-bypass")} disabled={isPending("toggle-bypass")} onClick={() => void toggleBypass(!bypass)}>{isPending("toggle-bypass") && <LoadingSpinner />}{bypass ? "Deactivate" : "Activate"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div>
        {data.bypassSessions.length > 0 && <div className="space-y-3 rounded-lg border p-4"><div><div className="font-medium">Unlimited Mode history</div><div className="text-sm text-muted-foreground">Each activation is recorded as its own session.</div></div><Table><TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Ended</TableHead><TableHead>Duration</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{data.bypassSessions.map((session) => <TableRow key={session.id}><TableCell className="text-sm">{formatSessionDate(session.startedAt)}</TableCell><TableCell className="text-sm text-muted-foreground">{formatSessionDate(session.endedAt)}</TableCell><TableCell className="text-sm tabular-nums">{formatSessionDuration(session.startedAt, session.endedAt)}</TableCell><TableCell><Badge variant={session.endedAt ? "outline" : "secondary"}>{session.endedAt ? "Completed" : "Active"}</Badge></TableCell></TableRow>)}</TableBody></Table></div>}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-sm font-medium">Budget usage</div><div className="text-xs text-muted-foreground">Usage is measured across the shared budget window.</div></div><div className="flex flex-col gap-2 sm:w-auto"><span className="text-sm font-medium">Order rows by</span><Select value={sortBy} onValueChange={(value) => { if (value) setSortBy(value as BudgetSortKey) }}><SelectTrigger className="min-w-44"><span className="truncate">{budgetSortLabel(sortBy)}</span></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Ordering</SelectLabel>{budgetSortOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select></div></div>
        <Table><TableHeader><TableRow><TableHead>Key</TableHead><TableHead>Status</TableHead><TableHead>Limit</TableHead><TableHead>Usage</TableHead><TableHead /></TableRow></TableHeader><TableBody>{sortedBudgets.map((budget) => { const toggleKey = `toggle-budget:${budget.apiKeyId}`; const deleteKey = `delete-budget:${budget.apiKeyId}`; const updateKey = `update-limit:${budget.apiKeyId}`; const percentUsed = budget.weeklyLimitMicros > 0 ? budget.spentMicros / budget.weeklyLimitMicros * 100 : 0; const remainingMicros = Math.max(0, budget.weeklyLimitMicros - budget.spentMicros); return <TableRow key={budget.apiKeyId} className="align-top"><TableCell className="font-medium">{budget.name}</TableCell><TableCell className="align-middle"><Badge variant={!budget.enabled ? "outline" : !bypass && budget.spentMicros >= budget.weeklyLimitMicros ? "destructive" : "secondary"}>{!budget.enabled ? "Disabled" : !bypass && budget.spentMicros >= budget.weeklyLimitMicros ? "Exceeded" : "Active"}</Badge></TableCell><TableCell className="align-middle tabular-nums">{bypass ? <span className="unlimited-shine inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-sm font-semibold tabular-nums"><span className="font-mono">∞</span><span>Unlimited</span></span> : money(budget.weeklyLimitMicros)}</TableCell><TableCell className="min-w-52"><div className="space-y-2"><div className="flex items-center justify-between gap-3"><span className="text-xs font-medium text-muted-foreground">{bypass ? `${money(budget.spentMicros)} since ${formatWindowDate(budget.usageStartAt || data.window.start)}` : `${money(budget.spentMicros)} / ${money(budget.weeklyLimitMicros)}`}</span>{bypass ? <span className="unlimited-shine inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold tabular-nums"><span className="font-mono">∞</span><span>Unlimited</span></span> : <span className="text-xs text-muted-foreground tabular-nums">{Math.round(percentUsed)}%</span>}</div><Progress value={bypass ? 100 : Math.min(percentUsed, 100)} className={bypass ? "unlimited-progress" : undefined}><ProgressLabel className="sr-only">Budget usage</ProgressLabel></Progress><div className="text-xs text-muted-foreground">{bypass ? "Unlimited Usage" : `${money(remainingMicros)} remaining`}</div></div></TableCell><TableCell className="align-middle text-right"><div className="flex flex-wrap justify-end gap-2"><Button aria-busy={isPending(toggleKey)} size="sm" variant="outline" disabled={isPending(toggleKey) || isPending(deleteKey) || isPending(updateKey)} onClick={() => void toggle(budget.apiKeyId, !budget.enabled, budget.weeklyLimitMicros)}>{isPending(toggleKey) && <LoadingSpinner />}{budget.enabled ? "Disable" : "Enable"}</Button><Popover open={editingBudgetId === budget.apiKeyId} onOpenChange={(open) => { if (open) { setEditingBudgetId(budget.apiKeyId); setEditLimitValue((budget.weeklyLimitMicros / 1_000_000).toFixed(2)) } else if (!isPending(updateKey)) setEditingBudgetId(null) }}><PopoverTrigger render={<Button size="sm" variant="outline" disabled={isPending(toggleKey) || isPending(deleteKey) || isPending(updateKey)}>Limit</Button>} /><PopoverContent className="w-auto p-3" align="end"><div className="flex flex-col gap-2"><label htmlFor={`budget-limit-${budget.apiKeyId}`} className="text-sm font-medium">Edit Limit ($)</label><div className="flex items-center gap-2"><div className="relative"><DollarSignIcon aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input id={`budget-limit-${budget.apiKeyId}`} type="number" value={editLimitValue} onChange={(event) => setEditLimitValue(sanitizeNonNegativeDraft(event.target.value))} min="0.01" step="0.01" className="h-8 w-28 pl-7" /></div><Button aria-busy={isPending(updateKey)} size="sm" disabled={isPending(updateKey) || Number(editLimitValue) <= 0} onClick={() => void updateLimit(budget.apiKeyId, Number(editLimitValue), budget.enabled)}>{isPending(updateKey) && <LoadingSpinner />}Save</Button></div></div></PopoverContent></Popover><ConfirmAction buttonLabel="Delete" title={`Delete ${budget.name}?`} description="This permanently deletes the budget configuration for this gateway key." pending={isPending(deleteKey)} disabled={isPending(deleteKey) || isPending(toggleKey) || isPending(updateKey)} onConfirm={() => remove(budget.apiKeyId)} /></div></TableCell></TableRow> })}{!sortedBudgets.length && <EmptyRow label="No budgets configured yet." colSpan={5} />}</TableBody></Table>
      </CardContent>
    </Card>
  </div></main>
}

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
    <Table><TableHeader><TableRow><TableHead>Group</TableHead><TableHead>Type</TableHead><TableHead>Models</TableHead><TableHead>Current pricing</TableHead><TableHead /></TableRow></TableHeader><TableBody>{data.groups.map((group) => { const members = modelsForGroup(group); const contextTiers = Array.isArray(group.currentVersion?.contextTiers) ? group.currentVersion.contextTiers : []; return <TableRow key={group.id}><TableCell><div className="font-medium">{group.name}</div><div className="text-xs text-muted-foreground">{group.currentVersion ? `v${group.currentVersion.version} active ${formatAppDate(group.currentVersion.effectiveAt)}` : "No version configured"}</div>{(group.canonicalModel || group.canonicalModelId) && <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground"><span className="shrink-0">{canonicalSourceLabel(group.canonicalSource || "custom")}</span><span className="truncate">{group.canonicalModel?.name || group.canonicalModelId}</span></div>}</TableCell><TableCell><Badge variant={group.kind === "fixed" ? "outline" : "secondary"}>{group.kind === "fixed" ? "Fixed" : "Custom"}</Badge></TableCell><TableCell><div className="font-medium tabular-nums">{members.length}</div><div className="text-xs text-muted-foreground">{members.slice(0, 2).map((model) => model.gatewayModelId).join(", ")}{members.length > 2 ? ` +${members.length - 2}` : ""}</div></TableCell><TableCell>{group.currentVersion ? <div><div className="font-medium">{formatRate(group.currentVersion.inputMicrosPerMillion)} input</div><div className="text-xs text-muted-foreground">{contextTiers.length ? `${contextTiers.length} context override${contextTiers.length === 1 ? "" : "s"}` : "Standard context"}</div></div> : <Badge variant="destructive">Missing</Badge>}</TableCell><TableCell className="text-right"><div className="flex flex-wrap justify-end gap-2"><Button size="sm" variant="outline" onClick={() => startGroupEdit(group.id)}><PencilIcon />Models</Button><Button size="sm" onClick={() => startPricingEdit(group.id)}>Pricing</Button>{group.kind === "custom" && <ConfirmAction buttonLabel="Delete" title={`Delete ${group.name}?`} description="Models will become ungrouped and can be assigned again." pending={pending} disabled={pending} onConfirm={() => deleteGroup(group.id)} />}</div></TableCell></TableRow> })}{!data.groups.length && <EmptyRow label="No model groups found. Refresh to scan configured models." colSpan={5} />}</TableBody></Table>
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
                  <PopoverTrigger render={<Button variant="outline" className="h-auto min-h-10 w-full justify-between gap-3 px-3 py-2 text-left" disabled={pending}><span className="min-w-0"><span className="block truncate font-medium">{canonicalModel?.name || canonicalModelId || "Select canonical model"}</span><span className="block truncate text-xs text-muted-foreground">{canonicalModel?.id || "Search model ID, name, or provider"}</span></span><ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" /></Button>} />
                  <PopoverContent side="bottom" align="start" sideOffset={6} className="w-(--anchor-width) min-w-0 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg p-0">
                  <div className="flex h-72 max-h-[calc(100vh-8rem)] min-h-0">
                    <Command className="min-h-0 flex-1 rounded-none p-0" shouldFilter={false}>
                      <CommandInput placeholder="Search model ID, name, or provider..." value={canonicalSearch} onValueChange={(value) => { setCanonicalSearch(value); setCanonicalLoading(true); setCanonicalError(null) }} />
                      <CommandList className="max-h-none min-h-0 flex-1 overscroll-contain overflow-y-auto px-2 py-1">
                        <CommandItem value="clear-canonical" onSelect={() => { setCanonicalModelId(""); setCanonicalModel(null); setCanonicalSearch(""); setCanonicalPopoverOpen(false) }}>Clear canonical link</CommandItem>
                        {canonicalLoading ? <div className="space-y-2 p-3">{Array.from({ length: 2 }, (_, index) => <div key={index} className="space-y-2 rounded-md px-3 py-2"><Skeleton className="h-4 w-40 max-w-full" /><Skeleton className="h-3 w-56 max-w-full" /></div>)}</div> : canonicalError ? <CommandEmpty>{canonicalError}</CommandEmpty> : canonicalModels.length === 0 ? <CommandEmpty>{canonicalSearch.trim() ? `No canonical models matched "${canonicalSearch.trim()}".` : "No canonical models available."}</CommandEmpty> : <CommandGroup heading={"Canonical models (" + canonicalModels.length + ")"} className="p-0">{canonicalModels.map((item) => <CommandItem key={item.id} value={item.name + " " + item.id + " " + item.provider} className="items-start gap-3 rounded-md px-3 py-2" onSelect={() => { setCanonicalModelId(item.id); setCanonicalModel(item); setGroupName(item.name); setCanonicalSearch(""); setCanonicalPopoverOpen(false) }}><div className="min-w-0 flex-1"><div className="truncate font-medium">{item.name}</div><div className="truncate text-xs text-muted-foreground">{item.id} · {item.provider}</div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground"><span>Input {formatCanonicalRate(item.pricing.inputMicrosPerMillion)}</span><span>Output {formatCanonicalRate(item.pricing.outputMicrosPerMillion)}</span><span>Cache read {formatCanonicalRate(item.pricing.cacheReadMicrosPerMillion)}</span></div></div>{canonicalModelId === item.id && <CheckIcon className="mt-1 size-4 text-primary" />}</CommandItem>)}</CommandGroup>}
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
    <Dialog open={Boolean(pricingDialog)} onOpenChange={(open) => { if (!open && !pending) setPricingDialog(undefined) }}><DialogContent className="max-w-4xl"><DialogHeader><DialogTitle>Pricing for {groupById(pricingDialog || "")?.name}</DialogTitle><DialogDescription>Set USD rates per million tokens. Context tiers override the standard rates when the input threshold is reached.</DialogDescription></DialogHeader><div className="grid gap-3 sm:grid-cols-2">{rateFields.map(([field, label]) => <label key={field} className="space-y-2 text-sm font-medium"><span className="block">{label}</span><div className="flex h-10 items-center rounded-md border bg-background"><span className="flex h-full items-center border-r px-3 text-muted-foreground">$</span><Input type="number" min="0" step="any" inputMode="decimal" value={rateDrafts[field]} onChange={(event) => { const value = event.target.value; setRateDrafts((current) => ({ ...current, [field]: sanitizeNonNegativeDraft(value) })); setRates((current) => ({ ...current, [field]: parseDollarInput(sanitizeNonNegativeDraft(value)) })) }} className="h-full border-0 shadow-none focus-visible:ring-0" /></div></label>)}</div><div className="space-y-3 overflow-hidden rounded-lg border p-3"><div className="flex items-center justify-between"><div><div className="text-sm font-medium">Context pricing</div><div className="text-xs text-muted-foreground">Add a higher-context threshold when the provider charges different rates.</div></div><Button size="sm" variant="outline" onClick={() => { const tier = { id: crypto.randomUUID(), thresholdTokens: 32000, ...rates }; setContextTiers((current) => [...current, tier]); setTierRateDrafts((current) => ({ ...current, [tier.id]: Object.fromEntries(rateFields.map(([field]) => [field, rateDrafts[field]])) })) }}><PlusIcon />Add tier</Button></div><div className="overflow-x-auto pb-1">{contextTiers.map((tier, index) => <div key={tier.id} className="grid min-w-[48rem] gap-3 rounded-md bg-muted/30 p-3 md:grid-cols-[minmax(7rem,1.1fr)_repeat(4,minmax(7rem,1fr))_auto]"><label className="flex min-w-0 flex-col gap-2 text-xs font-medium"><span className="flex min-h-8 items-end leading-4">Threshold</span><Input type="number" min="1" step="1" value={tier.thresholdTokens} onChange={(event) => setContextTiers((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, thresholdTokens: Number(event.target.value) } : entry))} /></label>{rateFields.map(([field, label]) => <label key={field} className="flex min-w-0 flex-col gap-2 text-xs font-medium"><span className="flex min-h-8 items-end leading-4">{label}</span><div className="flex h-10 items-center rounded-md border bg-background"><span className="flex h-full items-center border-r px-2 text-muted-foreground">$</span><Input type="number" min="0" step="any" inputMode="decimal" value={tierRateDrafts[tier.id]?.[field] ?? formatDollarInput(tier[field])} onChange={(event) => { const value = event.target.value; setTierRateDrafts((current) => ({ ...current, [tier.id]: { ...current[tier.id], [field]: sanitizeNonNegativeDraft(value) } })); setContextTiers((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, [field]: parseDollarInput(sanitizeNonNegativeDraft(value)) } : entry)) }} className="h-full min-w-0 border-0 px-2 shadow-none focus-visible:ring-0" /></div></label>)}<Button variant="ghost" size="sm" className="h-10 self-end" onClick={() => { setContextTiers((current) => current.filter((_, entryIndex) => entryIndex !== index)); setTierRateDrafts((current) => { const next = { ...current }; delete next[tier.id]; return next }) }}>Remove</Button></div>)}</div></div><DialogFooter><Button variant="outline" onClick={() => setPricingDialog(undefined)} disabled={pending}>Cancel</Button><Button variant="outline" onClick={() => setReplaceOpen(true)} disabled={pending || !groupById(pricingDialog || "")?.currentVersion}>{pending && <LoadingSpinner />}Replace current version</Button><Button onClick={() => void saveVersion("new")} disabled={pending}>{pending && <LoadingSpinner />}Save as new version</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={replaceOpen} onOpenChange={setReplaceOpen}><DialogContent><DialogHeader><DialogTitle>Reprice historical usage?</DialogTitle><DialogDescription>This replaces the active version and applies its rates to every stored request in this group. Requests without recorded token usage remain unpriced.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setReplaceOpen(false)} disabled={pending}>Cancel</Button><Button variant="destructive" onClick={() => void saveVersion("replace")} disabled={pending}>{pending && <LoadingSpinner />}Replace and reprice</Button></DialogFooter></DialogContent></Dialog>
  </Panel>
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
