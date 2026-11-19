import { ArrowLeftIcon, KeyRoundIcon, RefreshCwIcon } from "lucide-react"
import { Link, useParams } from "react-router"
import useSWR from "swr"
import { useDashboardApi } from "@rawroute/platform/web/api-context"
import { DashboardPage } from "@rawroute/ui/page-layout"
import { Alert, AlertDescription } from "@rawroute/ui/alert"
import { Button } from "@rawroute/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { Progress } from "@rawroute/ui/progress"
import { Separator } from "@rawroute/ui/separator"
import type { DashboardKeyBudget, DashboardPayload } from "../../contracts/domain"
import { groupRequestLogEvents, type PublicKeyUsageDetail, type RequestLogDisplayEvent, type RequestLogsPage } from "../../contracts/request-logs"
import { aiPagePaths as pagePaths, publicWorkspacePagePath } from "../../contracts/pages"
import { calendarDateFromInstant, formatAppDateTime } from "@rawroute/observability/contracts/timezone"
import { formatCost, formatRequestCount, formatTokenCount } from "../../contracts/usage-display"
import { useUsageDashboard } from "../use-usage-dashboard"
import { KeyUsageTrend } from "./key-usage-trend"
import { KeyUsageSkeleton } from "./key-usage-skeleton"
import { RequestLogResults } from "./request-logs-view"
import { UsageRangeToolbar } from "./usage-range-toolbar"

export function KeyUsageView({ publicView = false, workspaceId }: { publicView?: boolean; workspaceId?: string }) {
  const { keyId = "" } = useParams()
  return publicView
    ? <PublicKeyUsageContent key={`${workspaceId || ""}:${keyId}`} keyId={keyId} workspaceId={workspaceId} />
    : <DashboardKeyUsageContent key={keyId} keyId={keyId} />
}

function usePublicKeyUsage(keyId: string, workspaceId: string | undefined, apiFetch: ReturnType<typeof useDashboardApi>["apiFetch"]) {
  const url = `/api/public/usage/keys/${encodeURIComponent(keyId)}?workspace=${encodeURIComponent(workspaceId || "default")}`
  const usage = useSWR<PublicKeyUsageDetail>(workspaceId ? [workspaceId, "public-key-usage", keyId] : null, () => apiFetch<PublicKeyUsageDetail>(url), { revalidateOnFocus: false, refreshInterval: 15_000 })
  return {
    data: usage.data?.usage,
    error: usage.error,
    isValidating: usage.isValidating,
    refresh: () => { void usage.mutate().catch(() => undefined) },
    recentData: usage.data?.recent,
    recentError: usage.error,
  }
}

function costUnavailable(data: DashboardPayload) {
  const coverage = data.coverage
  return !!coverage && (coverage.financialUnavailable || coverage.excludedSources > 0 || coverage.costCoveredRequests < data.summary.requests)
}

export function trendUnavailable(data: DashboardPayload) {
  return costUnavailable(data) || (!!data.summary.requests && data.coverage?.tokenCoveredRequests === 0) || (data.summary.requests > 0 && data.trend.length === 0 && (data.coverage?.unsupportedTrendSources ?? 0) > 0)
}

function BackLink({ publicView, workspaceId }: { publicView?: boolean; workspaceId?: string }) {
  return <div><Button variant="ghost" nativeButton={false} role="link" render={<Link to={publicView ? publicWorkspacePagePath(workspaceId || "default") : pagePaths.overviewUsage} />}><ArrowLeftIcon data-icon="inline-start" />Back to usage</Button></div>
}

function KeyHeader({ label, sub, busy, onRefresh }: { label: string; sub: string; busy: boolean; onRefresh: () => void }) {
  return <div className="flex flex-wrap items-start justify-between gap-4">
    <div className="flex min-w-0 items-start gap-3"><div className="flex size-11 shrink-0 items-center justify-center rounded-lg border bg-muted/30"><KeyRoundIcon className="size-5" /></div><div className="min-w-0"><h2 className="break-words text-2xl font-semibold tracking-tight">{label}</h2><p className="mt-1 break-all text-xs text-muted-foreground">{sub}</p></div></div>
    <Button variant="outline" size="sm" disabled={busy} onClick={onRefresh}><RefreshCwIcon data-icon="inline-start" />Refresh</Button>
  </div>
}

function RecentRequests({ recentData, recentError }: { recentData?: { events: RequestLogDisplayEvent[] }; recentError: unknown }) {
  return <Card><CardHeader><CardTitle>Recent requests</CardTitle><CardDescription>Latest requests and their recorded attempts for this key</CardDescription></CardHeader><CardContent>
    {!!recentError && <Alert variant="destructive"><AlertDescription>Unable to load recent requests. Try refreshing.</AlertDescription></Alert>}
    <RequestLogResults data={recentData && { events: groupRequestLogEvents(recentData.events).slice(0, 5).flat() }} loading={!recentData && !recentError} failed={!!recentError} />
  </CardContent></Card>
}

function PublicKeyUsageContent({ keyId, workspaceId }: { keyId: string; workspaceId?: string }) {
  const { apiFetch } = useDashboardApi()
  const { data, error, isValidating, refresh, recentData, recentError } = usePublicKeyUsage(keyId, workspaceId, apiFetch)
  if (!data && !error) return <KeyUsageSkeleton rangeControls={false} />
  return <DashboardPage spacing="normal">
    <BackLink publicView workspaceId={workspaceId} />
    <KeyHeader label={data?.keys[0]?.label || keyId} sub="Public key usage" busy={isValidating} onRefresh={refresh} />
    {!!error && <Alert variant="destructive"><AlertDescription>Unable to load key usage. Try refreshing.{data && " Showing the last loaded data."}</AlertDescription></Alert>}
    {data && <>
      <div><h3 className="text-lg font-medium">Budget & spend</h3><p className="mt-1 text-sm text-muted-foreground">{formatAppDateTime(data.range.from)} – {formatAppDateTime(data.range.to)}</p></div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]"><BudgetBalance data={data} /><KeyUsageTrend data={data} unavailable={trendUnavailable(data)} /></div>
      <div className="grid gap-4 lg:grid-cols-2"><KeyModelSpend data={data} /><UsageProfile data={data} /></div>
      <RecentRequests recentData={recentData} recentError={recentError} />
    </>}
  </DashboardPage>
}

function useDashboardKeyUsage(keyId: string) {
  const { apiFetch, workspaceId } = useDashboardApi()
  const range = useUsageDashboard({ keyId, refreshIntervalMs: 15_000 })
  const budgetQuery = useSWR<DashboardPayload>(workspaceId && range.preset !== "budget" ? [workspaceId, "key-usage-budget", keyId] : null, () => apiFetch<DashboardPayload>(`/api/admin/usage/keys/${encodeURIComponent(keyId)}`), { revalidateOnFocus: false, refreshInterval: 15_000, keepPreviousData: true })
  const recent = useSWR<RequestLogsPage>(workspaceId ? [workspaceId, "key-recent", keyId] : null, () => {
    const to = new Date()
    const params = new URLSearchParams({ from: new Date(to.getTime() - 7 * 86_400_000).toISOString(), to: to.toISOString(), key: keyId })
    return apiFetch<RequestLogsPage>(`/api/admin/request-logs?${params}`)
  }, { revalidateOnFocus: false, refreshInterval: 15_000 })
  const data = range.dashboard
  const budgetData = range.loadedPreset === "budget" ? data : budgetQuery.data ?? range.lastBudgetPayload
  const refresh = () => { range.refresh(); void budgetQuery.mutate().catch(() => undefined); void recent.mutate().catch(() => undefined) }
  return { range, data, budgetData, recent, refresh, failed: Boolean(range.error || budgetQuery.error), label: budgetData?.keys[0]?.label || data?.keys[0]?.label || keyId }
}

function DashboardKeyUsageContent({ keyId }: { keyId: string }) {
  const { range, data, budgetData, recent, refresh, failed, label } = useDashboardKeyUsage(keyId)
  if ((!data || !budgetData) && !failed) return <KeyUsageSkeleton />
  return <DashboardPage spacing="normal">
    <BackLink />
    <KeyHeader label={label} sub={`Key usage · ${keyId}`} busy={range.pending} onRefresh={refresh} />
    {failed && <Alert variant="destructive"><AlertDescription>Unable to load key usage. Try refreshing.{data && " Showing the last loaded data."}</AlertDescription></Alert>}
    {data && budgetData && <DashboardKeyUsageBody data={data} budgetData={budgetData} range={range} recent={recent} />}
  </DashboardPage>
}

function DashboardKeyUsageBody({ data, budgetData, range, recent }: { data: DashboardPayload; budgetData: DashboardPayload; range: ReturnType<typeof useUsageDashboard>; recent: { data?: RequestLogsPage; error: unknown } }) {
  return <>
    <UsageRangeToolbar preset={range.preset} setPreset={range.setPreset} granularity={range.activeGranularity} setGranularity={range.setGranularity} selectedRange={range.preset === "custom" ? range.selectedRange : { from: calendarDateFromInstant(data.range.from), to: calendarDateFromInstant(data.range.to) }} onRangeChange={range.handleRangeChange} />
    <RangeSummary data={data} />
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]"><BudgetBalance data={budgetData} /><KeyUsageTrend data={data} unavailable={trendUnavailable(data)} /></div>
    <div className="grid gap-4 lg:grid-cols-2"><KeyModelSpend data={data} /><UsageProfile data={data} /></div>
    <RecentRequests recentData={recent.data} recentError={recent.error} />
  </>
}

function RangeSummary({ data }: { data: DashboardPayload }) {
  const tokensUnavailable = data.summary.requests > 0 && data.coverage?.tokenCoveredRequests === 0
  return <div className="flex flex-wrap gap-x-8 gap-y-2">
    <div><p className="text-lg font-semibold tabular-nums">{formatRequestCount(data.summary.requests)}</p><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Requests</p></div>
    <div><p className="text-lg font-semibold tabular-nums">{tokensUnavailable ? "Unavailable" : formatTokenCount(data.summary.tokens)}</p><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tokens</p></div>
    <div><p className="text-lg font-semibold tabular-nums">{costUnavailable(data) ? "Unavailable" : formatCost(data.summary.costMicros)}</p><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Cost</p></div>
  </div>
}

function budgetState(budget?: DashboardKeyBudget) {
  if (!budget) return { label: "No budget configured", value: "Unlimited" }
  if (budget.bypassLimits) return { label: "Unlimited mode active", value: "Unlimited" }
  if (budget.enabled === false) return { label: "Budget limits disabled", value: "Unlimited" }
  if (budget.weeklyLimitMicros <= 0) return { label: "No budget limit configured", value: "Unlimited" }
  if (budget.usageAvailable === false || budget.remainingMicros === null) return { label: "Remaining balance unavailable", value: "Unavailable" }
  return { label: "Remaining this window", value: formatCost(budget.remainingMicros) }
}

function averageDailyTokens(data: DashboardPayload, elapsedDays: number) {
  return data.summary.requests > 0 && data.coverage?.tokenCoveredRequests === 0 ? "Unavailable" : formatTokenCount(data.summary.tokens / elapsedDays)
}

function BudgetBalance({ data }: { data: DashboardPayload }) {
  const budget = data.keys[0]?.budget
  const state = budgetState(budget)
  const limited = budget && !budget.bypassLimits && budget.enabled !== false && budget.weeklyLimitMicros > 0
  const percent = budget?.percentUsed
  const elapsedDays = Math.max(1, (Math.min(Date.parse(data.generatedAt), Date.parse(data.range.to)) - Date.parse(data.range.from)) / 86_400_000)
  return <Card><CardHeader><CardTitle>Budget balance</CardTitle><CardDescription>{budget ? `${formatAppDateTime(budget.windowStart)} – ${formatAppDateTime(budget.windowEnd)}` : "This key has no configured spending limit."}</CardDescription></CardHeader><CardContent spacing="stack">
    <div><p className="text-sm text-muted-foreground">{state.label}</p><p className="mt-2 text-4xl font-semibold tracking-tight tabular-nums">{state.value}</p></div>
    {limited && budget.usageAvailable !== false && percent !== null && percent !== undefined && <Progress value={Math.min(100, percent)} aria-label={`Budget: ${percent.toFixed(1)} percent used`} />}
    {budget && <div className="flex flex-wrap justify-between gap-3 text-xs text-muted-foreground"><span>{budget.spentMicros === null || budget.usageAvailable === false ? "Usage unavailable" : `${formatCost(budget.spentMicros)} used`}</span><span>{formatCost(budget.weeklyLimitMicros)} allocated</span></div>}
    <Separator />
    <div className="grid grid-cols-2 gap-4"><div><p className="text-xs text-muted-foreground">Average daily spend so far</p><p className="mt-1 font-medium">{costUnavailable(data) ? "Unavailable" : formatCost(data.summary.costMicros / elapsedDays)}</p></div><div><p className="text-xs text-muted-foreground">Average daily tokens so far</p><p className="mt-1 font-medium">{averageDailyTokens(data, elapsedDays)}</p></div></div>
    <div><p className="text-xs text-muted-foreground">Budget reset</p><p className="mt-1 font-medium">{budget ? formatAppDateTime(budget.windowEnd) : "Not configured"}</p></div>
  </CardContent></Card>
}

function KeyModelSpend({ data }: { data: DashboardPayload }) {
  const unavailable = costUnavailable(data)
  return <Card className="min-w-0 self-start lg:self-stretch"><CardHeader><CardTitle>Where the spend goes</CardTitle><CardDescription>Resolved models used by this key</CardDescription></CardHeader><CardContent spacing="stack" className="max-h-128 overflow-y-auto">
    {!data.models.length ? <p className="text-sm text-muted-foreground">{unavailable ? "Model usage unavailable." : "No model usage in this window."}</p> : data.models.map(model => {
      const share = data.summary.costMicros > 0 ? model.costMicros / data.summary.costMicros * 100 : 0
      return <div key={model.model} className="flex flex-col gap-2"><div className="flex items-center justify-between gap-4"><div className="min-w-0"><p className="truncate font-medium" title={model.model}>{model.model}</p><p className="text-xs text-muted-foreground">{formatRequestCount(model.requests)} requests · {formatTokenCount(model.tokens)} tokens</p></div><div className="shrink-0 text-right"><p className="font-medium">{unavailable ? "Unavailable" : formatCost(model.costMicros)}</p>{!unavailable && <p className="text-xs text-muted-foreground">{share.toFixed(1)}% of spend</p>}</div></div>{!unavailable && <Progress value={share} aria-label={`${model.model}: ${share.toFixed(1)} percent of spend`} />}</div>
    })}
  </CardContent></Card>
}

function UsageProfile({ data }: { data: DashboardPayload }) {
  const unavailable = costUnavailable(data)
  const average = data.summary.requests ? data.summary.costMicros / data.summary.requests : 0
  const top = data.models[0]
  const tokensUnavailable = data.coverage ? data.coverage.tokenCoveredRequests === 0 : data.summary.requests === 0
  return <Card><CardHeader><CardTitle>Usage profile</CardTitle><CardDescription>How this key uses the gateway</CardDescription></CardHeader><CardContent spacing="stack">
    <div><p className="text-3xl font-semibold tabular-nums">{unavailable || !data.summary.requests ? "Unavailable" : formatCost(average)}</p><p className="mt-1 text-xs text-muted-foreground">Average cost per recorded request</p></div>
    <Separator />
    <div className="grid grid-cols-2 gap-4"><div><p className="text-lg font-medium">{formatRequestCount(data.summary.requests)}</p><p className="text-xs text-muted-foreground">Recorded requests</p></div><div><p className="text-lg font-medium">{tokensUnavailable ? "Unavailable" : formatTokenCount(data.summary.tokens)}</p><p className="text-xs text-muted-foreground">Tokens processed</p></div></div>
    <p className="text-sm text-muted-foreground">{unavailable ? "Financial coverage is incomplete for this window." : top && data.summary.costMicros > 0 ? `${top.model} accounts for ${(top.costMicros / data.summary.costMicros * 100).toFixed(1)}% of this key’s spend.` : "No spend recorded in this window."}</p>
  </CardContent></Card>
}