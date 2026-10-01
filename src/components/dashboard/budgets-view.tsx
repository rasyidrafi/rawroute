import { useEffect, useMemo, useState } from "react"
import { addDays, format } from "date-fns"
import type { DateRange } from "react-day-picker"
import { CalendarDaysIcon, ChartNoAxesCombinedIcon, Clock3Icon, DollarSignIcon, Link2Icon, RefreshCwIcon, ShieldCheckIcon, SparklesIcon, WalletCardsIcon } from "lucide-react"
import { toast } from "sonner"
import useSWR from "swr"

import { apiDelete, apiPatch, apiPost, fetcher } from "@/components/dashboard/api"
import { ConfirmAction, EmptyRow } from "@/components/dashboard/shared"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { LoadingSpinner } from "@/components/loading-spinner"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress, ProgressLabel } from "@/components/ui/progress"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { calendarDateFromInstant, formatAppDateTime, formatAppWindowDate, getZonedParts, zonedDateTimeToDate } from "@/lib/timezone"
import type { BudgetBeyondLimitsSettings, BudgetUnlimitedSettings, BudgetWindowAnchor } from "@/lib/types"

import { sanitizeNonNegativeDraft } from "@/components/dashboard/management-panel"

const money = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`
type BudgetWindowResponse = { start: string; end: string; anchor?: BudgetWindowAnchor; codexAccountId?: string | null; bypassLimits: boolean; bypassAutoDeactivateAtWindowEnd?: boolean }
type BudgetEntry = { apiKeyId: string; name: string; weeklyLimitMicros: number; spentMicros: number; enabled: boolean; usageStartAt?: string; lastUsedAt?: string | null }
type BudgetBypassSession = { id: string; startedAt: string; endedAt: string | null; endReason?: "manual" | "window_end" | null }
type BudgetModelOption = { id: string; name: string; provider: string }
type BudgetsResponse = { budgets: BudgetEntry[]; bypassSessions: BudgetBypassSession[]; window: BudgetWindowResponse; beyondLimits: BudgetBeyondLimitsSettings; unlimited: BudgetUnlimitedSettings; modelOptions: BudgetModelOption[]; apiKeys: Array<{ id: string; name: string }>; codexAccounts: CodexAccountOption[] }
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

export function BudgetsView() {
  const { data, mutate, isLoading, isValidating } = useSWR<BudgetsResponse>("/api/admin/budgets", fetcher, {
    refreshInterval: 300000,
    dedupingInterval: 300000,
    revalidateOnFocus: false,
  })
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
  const [bypassDialogOpen, setBypassDialogOpen] = useState(false)
  const [activationAutoDeactivate, setActivationAutoDeactivate] = useState(false)
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

  async function toggleBypass(enabled: boolean, autoDeactivateAtWindowEnd = false) {
    const pendingKey = "toggle-bypass"
    setPending((current) => new Set(current).add(pendingKey))
    try { await apiPatch("/api/admin/budgets/bypass", { enabled, ...(enabled ? { autoDeactivateAtWindowEnd } : {}) }); await mutate(); return true }
    catch (error) { toast.error(error instanceof Error ? error.message : "Unable to update Unlimited Mode"); return false }
    finally { setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next }) }
  }

  async function updateBypassAutoDeactivate(autoDeactivateAtWindowEnd: boolean) {
    const pendingKey = "update-bypass-auto-deactivate"
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiPatch("/api/admin/budgets/bypass", { autoDeactivateAtWindowEnd })
      await mutate()
      toast.success(autoDeactivateAtWindowEnd ? "Unlimited Mode will stop at the window end" : "Unlimited Mode will keep running")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to update Unlimited Mode") }
    finally { setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next }) }
  }

  async function saveUnlimited(excludedModelIds: string[]) {
    const pendingKey = "save-unlimited"
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiPatch("/api/admin/budgets/unlimited", { excludedModelIds })
      await mutate()
      toast.success("Unlimited Mode exclusions saved")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to save Unlimited Mode exclusions") }
    finally { setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next }) }
  }

  async function saveBeyondLimits(settings: Pick<BudgetBeyondLimitsSettings, "enabled" | "modelIds">) {
    const pendingKey = "save-beyond-limits"
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiPatch("/api/admin/budgets/beyond-limits", settings)
      await mutate()
      toast.success("Beyond Limits settings saved")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to save Beyond Limits settings") }
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

  useEffect(() => {
    if (!data?.window.bypassLimits || !data.window.bypassAutoDeactivateAtWindowEnd) return
    const delay = Date.parse(data.window.end) - Date.now()
    if (!Number.isFinite(delay)) return
    const timeout = window.setTimeout(() => void mutate(), Math.max(0, delay) + 250)
    return () => window.clearTimeout(timeout)
  }, [data?.window.bypassLimits, data?.window.bypassAutoDeactivateAtWindowEnd, data?.window.end, mutate])

  if (isLoading || !data) return <DashboardContentSkeleton variant="budgets" />
  const currentAnchor = data.window.anchor || "custom"
  const customRangeValid = Boolean(customRange?.from && customRange.to && dateToAppDateTime(customRange.from, customTime) < dateToAppDateTime(customRange.to, customTime))
  const minCustomDate = addDays(calendarDateFromInstant(new Date()), -7)
  const maxCustomDate = customRange?.from ? addDays(customRange.from, 7) : undefined

  return <main className="flex-1 bg-workspace p-4 dark:bg-background md:p-6 lg:p-8"><div className="mx-auto flex max-w-7xl flex-col gap-6">
    <Card>
      <CardHeader><CardTitle variant="icon"><Clock3Icon className="size-5" />Budget window</CardTitle><CardDescription>Choose the shared accounting window used by every gateway key.</CardDescription></CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div className="w-full max-w-sm flex-none"><div className="flex min-h-9 min-w-0 flex-col justify-center rounded-md border bg-muted/35 px-3 py-1.5"><div className="flex items-center justify-between gap-3"><span className="truncate text-sm tabular-nums">{formatWindowDate(data.window.start)} - {formatWindowDate(data.window.end)}</span><Badge variant="outline" className="shrink-0">{currentAnchor === "codex" ? <><Link2Icon className="size-3" />Codex synced</> : "Custom range"}</Badge></div><span className="text-xs text-muted-foreground">{currentAnchor === "codex" ? `Resets in ${formatBudgetResetIn(data.window.end)}; refreshed every 5 minutes` : "Manual date range; budget usage resets at the selected end date"}</span></div></div><div className="flex flex-col gap-3 sm:flex-row sm:items-end lg:ml-auto"><div className="flex w-full flex-col gap-2 sm:w-auto"><span className="text-sm font-medium">Window anchor</span><Select value={windowAnchor} onValueChange={(value) => { if (!value) return; const next = value as BudgetWindowAnchor; setWindowAnchorOverride(next); if (next === "codex" && !codexAccountId) setCodexAccountOverride(codexAccounts[0]?.id || "") }} disabled={isPending("budget-window")}><SelectTrigger className="min-w-48"><span>{windowAnchor === "codex" ? "Sync Codex account" : "Custom date range"}</span></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Budget window</SelectLabel><SelectItem value="codex" disabled={!codexAccounts.length}>Sync Codex account{!codexAccounts.length ? " (no accounts)" : ""}</SelectItem><SelectItem value="custom">Custom date range</SelectItem></SelectGroup></SelectContent></Select></div>{windowAnchor === "codex" ? <div className="flex w-full flex-col gap-2 sm:w-auto"><span className="text-sm font-medium">Codex account</span><Select value={codexAccountId} onValueChange={(value) => setCodexAccountOverride(value || "")} disabled={!codexAccounts.length || isPending("budget-window")}><SelectTrigger className="min-w-48"><SelectValue placeholder="Select account" /></SelectTrigger><SelectContent>{codexAccounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>)}</SelectContent></Select></div> : <Popover open={windowOpen} onOpenChange={setWindowOpen}><PopoverTrigger render={<Button variant="outline" disabled={isPending("budget-window")}><CalendarDaysIcon />{customRange?.from ? format(customRange.from, "MMM d") + ", " + customTime + " - " + (customRange.to ? format(customRange.to, "MMM d") + ", " + customTime : "Choose end") : "Choose dates"}</Button>} /><PopoverContent padding="none" className="w-auto" align="start"><Calendar mode="range" selected={customRange} defaultMonth={customRange?.from} onSelect={(next) => setCustomRangeOverride(next || null)} disabled={maxCustomDate ? { before: minCustomDate, after: maxCustomDate } : { before: minCustomDate }} numberOfMonths={1} fullWidth autoFocus /><div className="border-t p-3"><div className="flex items-center gap-3"><label htmlFor="budget-window-time" className="text-sm font-medium">Time</label><div className="flex items-center gap-2"><Select value={customHour} onValueChange={(value) => setCustomTimeOverride(value + ":" + customMinute)} disabled={isPending("budget-window")}><SelectTrigger aria-label="Hour"><SelectValue /></SelectTrigger><SelectContent>{TIME_HOURS.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select><span className="text-muted-foreground">:</span><Select value={customMinute} onValueChange={(value) => setCustomTimeOverride(customHour + ":" + value)} disabled={isPending("budget-window")}><SelectTrigger aria-label="Minute"><SelectValue /></SelectTrigger><SelectContent>{TIME_MINUTES.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div></div><p className="mt-2 text-xs text-muted-foreground">Applied to both the start and end dates.</p></div><div className="flex justify-end gap-2 border-t p-3"><Button variant="outline" size="sm" onClick={() => { setCustomRangeOverride({ from: calendarDateFromInstant(data.window.start), to: calendarDateFromInstant(data.window.end) }); setCustomTimeOverride(null); setWindowOpen(false) }}>Cancel</Button><Button size="sm" disabled={!customRangeValid} onClick={() => setWindowOpen(false)}>Apply</Button></div></PopoverContent></Popover>}<Button aria-busy={isPending("budget-window")} disabled={isPending("budget-window") || (windowAnchor === "codex" ? !codexAccountId : !customRangeValid)} onClick={() => void saveWindow()}>{isPending("budget-window") && <LoadingSpinner />}Save window</Button></div></div>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle variant="icon"><WalletCardsIcon className="size-5" />Budgets</CardTitle><CardDescription>Weekly USD limits for gateway API keys. Existing keys remain unlimited until configured.</CardDescription><CardAction><Button aria-busy={isValidating} variant="outline" onClick={() => void mutate()} disabled={isValidating}>{isValidating ? <LoadingSpinner /> : <RefreshCwIcon />}Refresh</Button></CardAction></CardHeader>
      <CardContent spacing="stack">
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
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div className="flex flex-col gap-3 sm:flex-row sm:items-end"><Select value={apiKeyId} onValueChange={(value) => setApiKeyId(value || "")}><SelectTrigger className="md:w-64"><SelectValue placeholder="Select gateway key" /></SelectTrigger><SelectContent>{data.apiKeys.filter((key) => !data.budgets.some((budget) => budget.apiKeyId === key.id)).map((key) => <SelectItem key={key.id} value={key.id}>{key.name}</SelectItem>)}</SelectContent></Select><div className="flex items-center gap-3"><div className="relative md:w-40"><DollarSignIcon aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input inset="icon"
                      className="md:w-40" value={limit} onChange={(event) => setLimit(sanitizeNonNegativeDraft(event.target.value))} type="number" min="0.01" step="0.01" placeholder="Weekly USD" /></div><Button aria-busy={isPending("create-budget")} onClick={() => void create()} disabled={isPending("create-budget") || !apiKeyId}>{isPending("create-budget") && <LoadingSpinner />}Create budget</Button></div></div></div>
        <Tabs defaultValue="unlimited" spacing="comfortable">
          <TabsList aria-label="Budget limit controls">
            <TabsTrigger value="unlimited">Unlimited Mode</TabsTrigger>
            <TabsTrigger value="beyond-limits">Beyond Limits</TabsTrigger>
          </TabsList>
          <TabsContent value="unlimited" spacing="stack">
            <UnlimitedSettings
              key={data.unlimited.updatedAt}
              settings={data.unlimited}
              modelOptions={data.modelOptions}
              window={data.window}
              sessions={data.bypassSessions}
              dialogOpen={bypassDialogOpen}
              activationAutoDeactivate={activationAutoDeactivate}
              togglePending={isPending("toggle-bypass")}
              autoPending={isPending("update-bypass-auto-deactivate")}
              savePending={isPending("save-unlimited")}
              onDialogOpenChange={(open) => { if (!isPending("toggle-bypass")) { setBypassDialogOpen(open); if (open && !bypass) setActivationAutoDeactivate(false) } }}
              onActivationAutoDeactivateChange={setActivationAutoDeactivate}
              onToggle={toggleBypass}
              onUpdateAutoDeactivate={updateBypassAutoDeactivate}
              onSave={saveUnlimited}
            />
          </TabsContent>
          <TabsContent value="beyond-limits">
            <BeyondLimitsSettings key={data.beyondLimits.updatedAt} settings={data.beyondLimits} modelOptions={data.modelOptions} pending={isPending("save-beyond-limits")} onSave={saveBeyondLimits} />
          </TabsContent>
        </Tabs>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-sm font-medium">Budget usage</div><div className="text-xs text-muted-foreground">Usage is measured across the shared budget window.</div></div><div className="flex flex-col gap-2 sm:w-auto"><span className="text-sm font-medium">Order rows by</span><Select value={sortBy} onValueChange={(value) => { if (value) setSortBy(value as BudgetSortKey) }}><SelectTrigger className="min-w-44"><span className="truncate">{budgetSortLabel(sortBy)}</span></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Ordering</SelectLabel>{budgetSortOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent></Select></div></div>
        <Table><TableHeader><TableRow><TableHead>Key</TableHead><TableHead>Status</TableHead><TableHead>Limit</TableHead><TableHead>Usage</TableHead><TableHead /></TableRow></TableHeader><TableBody>{sortedBudgets.map((budget) => { const toggleKey = `toggle-budget:${budget.apiKeyId}`; const deleteKey = `delete-budget:${budget.apiKeyId}`; const updateKey = `update-limit:${budget.apiKeyId}`; const percentUsed = budget.weeklyLimitMicros > 0 ? budget.spentMicros / budget.weeklyLimitMicros * 100 : 0; const remainingMicros = Math.max(0, budget.weeklyLimitMicros - budget.spentMicros); const overLimitMicros = Math.max(0, budget.spentMicros - budget.weeklyLimitMicros); return <TableRow key={budget.apiKeyId} className="align-top"><TableCell text="label">{budget.name}</TableCell><TableCell className="align-middle"><Badge variant={!budget.enabled ? "outline" : !bypass && budget.spentMicros >= budget.weeklyLimitMicros ? "destructive" : "secondary"}>{!budget.enabled ? "Disabled" : !bypass && budget.spentMicros >= budget.weeklyLimitMicros ? "Over limit" : "Active"}</Badge></TableCell><TableCell text="numeric" className="align-middle">{bypass ? <span className="unlimited-shine inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-sm font-semibold tabular-nums"><span className="font-mono">∞</span><span>Unlimited</span></span> : money(budget.weeklyLimitMicros)}</TableCell><TableCell className="min-w-52"><div className="space-y-2"><div className="flex items-center justify-between gap-3"><span className="text-xs font-medium text-muted-foreground">{bypass ? `${money(budget.spentMicros)} since ${formatWindowDate(budget.usageStartAt || data.window.start)}` : `${money(budget.spentMicros)} / ${money(budget.weeklyLimitMicros)}`}</span>{bypass ? <span className="unlimited-shine inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-caption font-semibold tabular-nums"><span className="font-mono">∞</span><span>Unlimited</span></span> : <span className={cn("text-xs tabular-nums", overLimitMicros > 0 ? "font-medium text-destructive" : "text-muted-foreground")}>{Math.round(percentUsed)}%</span>}</div><Progress value={bypass ? 100 : Math.min(percentUsed, 100)} variant={bypass ? "unlimited" : "default"}><ProgressLabel className="sr-only">Budget usage</ProgressLabel></Progress><div className={cn("text-xs", overLimitMicros > 0 ? "font-medium text-destructive" : "text-muted-foreground")}>{bypass ? "Unlimited Usage" : overLimitMicros > 0 ? `${money(overLimitMicros)} over limit` : `${money(remainingMicros)} remaining`}</div></div></TableCell><TableCell className="align-middle text-right"><div className="flex flex-wrap justify-end gap-2"><Button aria-busy={isPending(toggleKey)} size="sm" variant="outline" disabled={isPending(toggleKey) || isPending(deleteKey) || isPending(updateKey)} onClick={() => void toggle(budget.apiKeyId, !budget.enabled, budget.weeklyLimitMicros)}>{isPending(toggleKey) && <LoadingSpinner />}{budget.enabled ? "Disable" : "Enable"}</Button><Popover open={editingBudgetId === budget.apiKeyId} onOpenChange={(open) => { if (open) { setEditingBudgetId(budget.apiKeyId); setEditLimitValue((budget.weeklyLimitMicros / 1_000_000).toFixed(2)) } else if (!isPending(updateKey)) setEditingBudgetId(null) }}><PopoverTrigger render={<Button size="sm" variant="outline" disabled={isPending(toggleKey) || isPending(deleteKey) || isPending(updateKey)}>Limit</Button>} /><PopoverContent padding="comfortable" className="w-auto" align="end"><div className="flex flex-col gap-2"><label htmlFor={`budget-limit-${budget.apiKeyId}`} className="text-sm font-medium">Edit Limit ($)</label><div className="flex items-center gap-2"><div className="relative"><DollarSignIcon aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input id={`budget-limit-${budget.apiKeyId}`} type="number" value={editLimitValue} onChange={(event) => setEditLimitValue(sanitizeNonNegativeDraft(event.target.value))} min="0.01" step="0.01" inset="prefix"
                                      className="h-8 w-28" /></div><Button aria-busy={isPending(updateKey)} size="sm" disabled={isPending(updateKey) || Number(editLimitValue) <= 0} onClick={() => void updateLimit(budget.apiKeyId, Number(editLimitValue), budget.enabled)}>{isPending(updateKey) && <LoadingSpinner />}Save</Button></div></div></PopoverContent></Popover><ConfirmAction buttonLabel="Delete" title={`Delete ${budget.name}?`} description="This permanently deletes the budget configuration for this gateway key." pending={isPending(deleteKey)} disabled={isPending(deleteKey) || isPending(toggleKey) || isPending(updateKey)} onConfirm={() => remove(budget.apiKeyId)} /></div></TableCell></TableRow> })}{!sortedBudgets.length && <EmptyRow label="No budgets configured yet." colSpan={5} />}</TableBody></Table>
      </CardContent>
    </Card>
  </div></main>
}

function BudgetModelSelector({ title, description, modelIds, modelOptions, pending, onChange }: { title: string; description: string; modelIds: string[]; modelOptions: BudgetModelOption[]; pending: boolean; onChange: (modelIds: string[]) => void }) {
  const [search, setSearch] = useState("")
  const normalizedSearch = search.trim().toLowerCase()
  const uniqueOptions = useMemo(() => [...new Map(modelOptions.map((model) => [model.id, model])).values()], [modelOptions])
  const filteredOptions = useMemo(() => uniqueOptions.filter((model) => !normalizedSearch || `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(normalizedSearch)), [normalizedSearch, uniqueOptions])
  const toggleModel = (id: string, selected: boolean) => onChange(selected ? [...new Set([...modelIds, id])] : modelIds.filter((modelId) => modelId !== id))

  return <div className="space-y-3">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><div className="text-sm font-medium">{title}</div><p className="text-xs text-muted-foreground">{description}</p></div><div className="flex items-center gap-2"><Badge variant="outline">{modelIds.length} selected</Badge>{modelIds.length > 0 && <Button size="sm" variant="ghost" disabled={pending} onClick={() => onChange([])}>Clear all</Button>}</div></div>
    <Input aria-label={`Search ${title.toLowerCase()}`} placeholder="Search model name, ID, or provider" value={search} onChange={(event) => setSearch(event.target.value)} disabled={pending} />
    <div className="max-h-80 divide-y overflow-y-auto rounded-lg border">{filteredOptions.map((model) => { const selected = modelIds.includes(model.id); return <label key={model.id} className="flex cursor-pointer items-center gap-3 px-3 py-3 hover:bg-muted/40"><Checkbox checked={selected} onCheckedChange={(checked) => toggleModel(model.id, checked === true)} disabled={pending} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{model.name}</span><span className="block truncate text-xs text-muted-foreground">{model.id} · {model.provider}</span></span></label> })}{!filteredOptions.length && <div className="px-4 py-8 text-center text-sm text-muted-foreground">{uniqueOptions.length ? "No models match your search." : "No enabled models are available."}</div>}</div>
  </div>
}

function UnlimitedSettings({ settings, modelOptions, window, sessions, dialogOpen, activationAutoDeactivate, togglePending, autoPending, savePending, onDialogOpenChange, onActivationAutoDeactivateChange, onToggle, onUpdateAutoDeactivate, onSave }: {
  settings: BudgetUnlimitedSettings
  modelOptions: BudgetModelOption[]
  window: BudgetWindowResponse
  sessions: BudgetBypassSession[]
  dialogOpen: boolean
  activationAutoDeactivate: boolean
  togglePending: boolean
  autoPending: boolean
  savePending: boolean
  onDialogOpenChange: (open: boolean) => void
  onActivationAutoDeactivateChange: (enabled: boolean) => void
  onToggle: (enabled: boolean, autoDeactivateAtWindowEnd?: boolean) => Promise<boolean>
  onUpdateAutoDeactivate: (enabled: boolean) => Promise<void>
  onSave: (excludedModelIds: string[]) => Promise<void>
}) {
  const [excludedModelIds, setExcludedModelIds] = useState(settings.excludedModelIds)
  const active = window.bypassLimits
  const autoDeactivate = window.bypassAutoDeactivateAtWindowEnd === true
  const dirty = [...excludedModelIds].sort().join("\0") !== [...settings.excludedModelIds].sort().join("\0")
  const endLabel = formatSessionDate(window.end)

  return <>
    <div className="rounded-xl border">
      <div className="flex flex-col gap-4 border-b bg-muted/10 p-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2 font-medium"><SparklesIcon className="size-4 text-warning" />Unlimited Mode <Badge variant={active ? "secondary" : "outline"}>{active ? "Active" : "Inactive"}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{active ? autoDeactivate ? `Budget limits are bypassed until ${endLabel}.` : "Budget limits are bypassed until you deactivate Unlimited Mode." : "Activate a temporary budget bypass while keeping expensive models blocked."}</p>{active && <div className="mt-3 flex items-start gap-3 rounded-lg border bg-background px-3 py-2"><Checkbox id="unlimited-auto-deactivate-active" checked={autoDeactivate} onCheckedChange={(checked) => void onUpdateAutoDeactivate(checked === true)} disabled={autoPending || togglePending} /><label htmlFor="unlimited-auto-deactivate-active" className="cursor-pointer text-sm"><span className="block font-medium">Auto-deactivate at budget window end</span><span className="block text-xs text-muted-foreground">{autoDeactivate ? `Scheduled for ${endLabel}.` : "This session will continue into the next budget window."}</span></label></div>}</div><AlertDialog open={dialogOpen} onOpenChange={onDialogOpenChange}><Button aria-busy={togglePending} variant={active ? "unlimited" : "unlimited-idle"} className="h-9 min-w-40" disabled={togglePending} onClick={() => onDialogOpenChange(true)}>{togglePending ? <LoadingSpinner /> : <SparklesIcon className="size-4" />}{active ? "Deactivate" : "Activate"}</Button><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{active ? "Deactivate Unlimited Mode?" : "Activate Unlimited Mode?"}</AlertDialogTitle><AlertDialogDescription>{active ? "Budget enforcement will resume immediately for every gateway key." : "Configured gateway keys will bypass their budget limits. Excluded models will stay blocked."}</AlertDialogDescription></AlertDialogHeader>{!active && <div className="space-y-3"><div className={cn("rounded-lg border p-3 text-sm", excludedModelIds.length ? "bg-muted/25" : "border-warning/30 bg-warning/5")}><div className="font-medium">{excludedModelIds.length ? `${excludedModelIds.length} model${excludedModelIds.length === 1 ? "" : "s"} will stay blocked` : "No models are excluded"}</div><div className="mt-1 text-xs text-muted-foreground">{excludedModelIds.length ? "You can change this list while Unlimited Mode is active." : "Every available model can be used during this session."}</div></div><div className="flex items-start gap-3 rounded-lg border p-3"><Checkbox id="unlimited-auto-deactivate-activation" checked={activationAutoDeactivate} onCheckedChange={(checked) => onActivationAutoDeactivateChange(checked === true)} disabled={togglePending} /><label htmlFor="unlimited-auto-deactivate-activation" className="cursor-pointer text-sm"><span className="block font-medium">Auto-deactivate at budget window end</span><span className="block text-xs text-muted-foreground">Stop this session on {endLabel}.</span></label></div></div>}<AlertDialogFooter><AlertDialogCancel disabled={togglePending}>Cancel</AlertDialogCancel><AlertDialogAction aria-busy={togglePending} disabled={togglePending} onClick={async () => { if (await onToggle(!active, activationAutoDeactivate)) onDialogOpenChange(false) }}>{togglePending && <LoadingSpinner />}{active ? "Deactivate" : "Activate Unlimited Mode"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div>
      <div className="space-y-3 p-4"><BudgetModelSelector title="Excluded models" description="These models cannot start new requests while Unlimited Mode is active." modelIds={excludedModelIds} modelOptions={modelOptions} pending={savePending} onChange={setExcludedModelIds} /><div className="flex flex-col gap-3 rounded-lg border border-warning/25 bg-warning/5 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"><span className="text-muted-foreground">Saved changes apply to new requests immediately. Running requests are not interrupted.</span><Button aria-busy={savePending} disabled={savePending || !dirty} onClick={() => void onSave(excludedModelIds)}>{savePending && <LoadingSpinner />}Save exclusions</Button></div></div>
    </div>
    <div className="rounded-xl border"><div className="border-b px-4 py-3"><div className="font-medium">Unlimited Mode history</div><div className="text-sm text-muted-foreground">Each activation is recorded as its own session.</div></div>{sessions.length ? <Table><TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Ended</TableHead><TableHead>Duration</TableHead><TableHead>Result</TableHead></TableRow></TableHeader><TableBody>{sessions.map((session) => <TableRow key={session.id}><TableCell >{formatSessionDate(session.startedAt)}</TableCell><TableCell tone="muted">{formatSessionDate(session.endedAt)}</TableCell><TableCell text="numeric">{formatSessionDuration(session.startedAt, session.endedAt)}</TableCell><TableCell><Badge variant={session.endedAt ? "outline" : "secondary"}>{!session.endedAt ? "Active" : session.endReason === "window_end" ? "Window ended" : session.endReason === "manual" ? "Deactivated" : "Completed"}</Badge></TableCell></TableRow>)}</TableBody></Table> : <div className="px-4 py-8 text-center text-sm text-muted-foreground">No Unlimited Mode sessions yet.</div>}</div>
  </>
}

function BeyondLimitsSettings({ settings, modelOptions, pending, onSave }: { settings: BudgetBeyondLimitsSettings; modelOptions: BudgetModelOption[]; pending: boolean; onSave: (settings: Pick<BudgetBeyondLimitsSettings, "enabled" | "modelIds">) => Promise<void> }) {
  const [enabled, setEnabled] = useState(settings.enabled)
  const [modelIds, setModelIds] = useState(settings.modelIds)

  return <div className="rounded-xl border">
    <div className="flex flex-col gap-4 border-b p-4 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex items-center gap-2 font-medium"><ShieldCheckIcon className="size-4 text-primary" />Beyond Limits</div><p className="mt-1 text-sm text-muted-foreground">Let selected models continue after a gateway key reaches its budget. Their usage still counts and can exceed the limit.</p></div><div className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2"><Checkbox id="beyond-limits-enabled" checked={enabled} onCheckedChange={(checked) => setEnabled(checked === true)} disabled={pending} /><label htmlFor="beyond-limits-enabled" className="cursor-pointer text-sm font-medium">Enabled</label></div></div>
    <div className="space-y-3 p-4"><BudgetModelSelector title="Allowed models" description="These exceptions apply only after a key reaches its limit." modelIds={modelIds} modelOptions={modelOptions} pending={pending} onChange={setModelIds} /><div className="flex flex-col gap-3 rounded-lg border border-warning/25 bg-warning/5 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"><span className="text-muted-foreground">Budget rows will show actual usage above the limit when these models keep running.</span><Button aria-busy={pending} disabled={pending} onClick={() => void onSave({ enabled, modelIds })}>{pending && <LoadingSpinner />}Save settings</Button></div></div>
  </div>
}
