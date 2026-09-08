"use client"

import { useEffect, useState } from "react"

import { TableCell } from "@/components/ui/table"

export type QuotaWindow = {
  usedPercent: number
  remainingPercent: number
  resetAt?: string
}

export type AccountUsage = {
  fiveHour: QuotaWindow | null
  weekly: QuotaWindow | null
  unusedResetCredits?: number
  fetchedAt: string | null
  stale: boolean
  error?: string
  reauthRequired?: boolean
}

export type UsageResponse = {
  accounts: Record<string, AccountUsage>
}

function resetCountdown(value?: string) {
  if (!value) return undefined
  const remainingMs = new Date(value).getTime() - Date.now()
  if (!Number.isFinite(remainingMs)) return undefined
  if (remainingMs <= 0) return "now"
  const minutes = Math.ceil(remainingMs / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) return `${hours}h ${remainingMinutes}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export function getAvailableQuotaWindows(accountUsage?: Pick<AccountUsage, "fiveHour" | "weekly">) {
  return [
    { label: "5 hour", quota: accountUsage?.fiveHour },
    { label: "Weekly", quota: accountUsage?.weekly },
  ].filter((entry): entry is { label: string; quota: QuotaWindow } => Boolean(entry.quota))
}

export function codexUsageError(accountUsage?: AccountUsage, requestError?: string) {
  if (accountUsage?.reauthRequired) return "Authentication token expired. Reauthorize this Codex account."
  return accountUsage?.error || requestError
}

function QuotaLine({ label, quota, loading }: { label: string; quota?: QuotaWindow; loading: boolean }) {
  const [, setClock] = useState(0)
  const remaining = quota ? Math.round(quota.remainingPercent) : undefined
  const countdown = resetCountdown(quota?.resetAt)

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 60000)
    return () => clearInterval(timer)
  }, [])

  return <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {loading ? <span className="h-4 w-10 animate-pulse rounded bg-muted" /> : <span className="font-medium text-muted-foreground">{remaining === undefined ? "N/A" : `${remaining}%`}</span>}
      {!loading && countdown && <span>resets in {countdown}</span>}
  </div>
}

export function CodexQuotaTableCell({ accountUsage, loading, error, routingStatus }: { accountUsage?: AccountUsage; loading: boolean; error?: string; routingStatus?: string }) {
  const windows = getAvailableQuotaWindows(accountUsage)
  const message = codexUsageError(accountUsage, error)

  return <TableCell className="min-w-40 bg-muted/20 px-3 py-2">
    {loading ? <span className="inline-block h-4 w-20 animate-pulse rounded bg-muted" /> : !message && windows.length ? <div className="grid gap-1.5">
      {windows.map(({ label, quota }) => <QuotaLine key={label} label={label} quota={quota} loading={false} />)}
      {routingStatus?.includes("usage_limit_reached") && <span className="text-xs text-amber-600">Last inference hit a quota limit. Routing may still be cooling down.</span>}
      {accountUsage?.stale && <span className="text-xs text-muted-foreground">Usage is from an earlier check.</span>}
    </div> : <span className="text-sm text-muted-foreground">N/A</span>}
  </TableCell>
}
