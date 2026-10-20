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
import type { PublicKeyUsageDetail, RequestLogDisplayEvent, RequestLogsPage } from "../../contracts/request-logs"
import { aiPagePaths as pagePaths, publicWorkspacePagePath } from "../../contracts/pages"
import { formatAppDateTime } from "@rawroute/observability/contracts/timezone"
import { formatCost, formatRequestCount, formatTokenCount } from "../../contracts/usage-display"
import { KeySpendChart } from "./key-spend-chart"
import { KeyUsageSkeleton } from "./key-usage-skeleton"
import { RequestLogResults } from "./request-logs-view"

export function KeyUsageView({ publicView = false, workspaceId }: { publicView?: boolean; workspaceId?: string }) {
  const { keyId = "" } = useParams()
  return <KeyUsageContent key={`${workspaceId || ""}:${keyId}`} keyId={keyId} publicView={publicView} workspaceId={workspaceId} />
}

type KeyUsageState = {
  data?: DashboardPayload
  error: unknown
  isValidating: boolean
  refresh: () => void
  recentData?: { events: RequestLogDisplayEvent[] }
  recentError: unknown
}

function useKeyUsage(keyId: string, publicView: boolean, selectedWorkspaceId?: string) {
  const { apiFetch, workspaceId } = useDashboardApi()
  const publicUsage = usePublicKeyUsage(keyId, selectedWorkspaceId, apiFetch)
  const dashboardUsage = useDashboardKeyUsage(keyId, workspaceId, apiFetch)
  return publicView ? publicUsage : dashboardUsage
}

function usePublicKeyUsage(keyId: string, workspaceId: string | undefined, apiFetch: ReturnType<typeof useDashboardApi>["apiFetch"]): KeyUsageState {
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

function useDashboardKeyUsage(keyId: string, workspaceId: string | null, apiFetch: ReturnType<typeof useDashboardApi>["apiFetch"]): KeyUsageState {
  const usage = useSWR<DashboardPayload>(workspaceId ? [workspaceId, "key-usage", keyId] : null, () => apiFetch<DashboardPayload>(`/api/admin/usage/keys/${encodeURIComponent(keyId)}`), { revalidateOnFocus: false, refreshInterval: 15_000 })
  const params = usage.data ? new URLSearchParams({ from: usage.data.range.from, to: usage.data.range.to, key: keyId }) : null
  const recentUrl = params ? `/api/admin/request-logs?${params}` : null
  const recent = useSWR<RequestLogsPage>(workspaceId && recentUrl ? [workspaceId, recentUrl] : null, () => apiFetch<RequestLogsPage>(recentUrl!), { revalidateOnFocus: false, refreshInterval: 15_000 })
  return {
    data: usage.data,
    error: usage.error,
    isValidating: usage.isValidating,
    refresh: () => { void usage.mutate().catch(() => undefined); void recent.mutate().catch(() => undefined) },
    recentData: recent.data,
    recentError: recent.error,
  }
}

function costUnavailable(data: DashboardPayload) {
  const coverage = data.coverage
  return !!coverage && (coverage.financialUnavailable || coverage.excludedSources > 0 || coverage.costCoveredRequests < data.summary.requests)
}

function KeyUsageContent({ keyId, publicView, workspaceId }: { keyId: string; publicView: boolean; workspaceId?: string }) {
  const { data, error, isValidating, refresh, recentData, recentError } = useKeyUsage(keyId, publicView, workspaceId)
  if (!data && !error) return <KeyUsageSkeleton />
  return <DashboardPage spacing="normal">
    <div><Button variant="ghost" nativeButton={false} role="link" render={<Link to={publicView ? publicWorkspacePagePath(workspaceId || "default") : pagePaths.overviewUsage} />}><ArrowLeftIcon data-icon="inline-start" />Back to usage</Button></div>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3"><div className="flex size-11 shrink-0 items-center justify-center rounded-lg border bg-muted/30"><KeyRoundIcon className="size-5" /></div><div className="min-w-0"><h2 className="break-words text-2xl font-semibold tracking-tight">{data?.keys[0]?.label || keyId}</h2><p className="mt-1 break-all text-xs text-muted-foreground">{publicView ? "Public key usage" : `Key usage · ${keyId}`}</p></div></div>
      <Button variant="outline" size="sm" disabled={isValidating} onClick={refresh}><RefreshCwIcon data-icon="inline-start" />Refresh</Button>
    </div>
    {!!error && <Alert variant="destructive"><AlertDescription>Unable to load key usage. Try refreshing.{data && " Showing the last loaded data."}</AlertDescription></Alert>}
    {data && <>
      <div><h3 className="text-lg font-medium">Budget & spend</h3><p className="mt-1 text-sm text-muted-foreground">{formatAppDateTime(data.range.from)} – {formatAppDateTime(data.range.to)}</p></div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]"><BudgetBalance data={data} /><KeySpendChart data={data} unavailable={costUnavailable(data)} /></div>
      <div className="grid gap-4 lg:grid-cols-2"><KeyModelSpend data={data} /><UsageProfile data={data} /></div>
      <Card><CardHeader><CardTitle>Recent requests</CardTitle><CardDescription>Latest recorded attempts for this key</CardDescription></CardHeader><CardContent>
        {!!recentError && <Alert variant="destructive"><AlertDescription>Unable to load recent requests. Try refreshing.</AlertDescription></Alert>}
        <RequestLogResults data={recentData && { events: recentData.events.slice(0, 5) }} loading={!recentData && !recentError} failed={!!recentError} />
      </CardContent></Card>
    </>}
  </DashboardPage>
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
