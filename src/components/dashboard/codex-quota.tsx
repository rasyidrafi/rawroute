"use client"

import { useEffect, useState } from "react"

import { TableCell, TableRow } from "@/components/ui/table"

export type QuotaWindow = {
  usedPercent: number
  remainingPercent: number
  resetAt?: string
}

export type AccountUsage = {
  fiveHour: QuotaWindow | null
  weekly: QuotaWindow | null
  fetchedAt: string | null
  stale: boolean
  error?: string
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

function QuotaLine({ label, quota, loading, stale }: { label: string; quota?: QuotaWindow | null; loading: boolean; stale: boolean }) {
  const [, setClock] = useState(0)
  const remaining = quota ? Math.round(quota.remainingPercent) : undefined
  const used = quota ? Math.round(quota.usedPercent) : undefined
  const countdown = resetCountdown(quota?.resetAt)

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 60000)
    return () => clearInterval(timer)
  }, [])

  return <div className="grid gap-1.5">
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {loading ? <span className="h-4 w-10 animate-pulse rounded bg-muted" /> : <span className="font-medium text-muted-foreground">{remaining === undefined ? "N/A" : `${remaining}%`}</span>}
    </div>
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-foreground transition-[width] duration-300" style={{ width: `${remaining ?? 0}%` }} />
    </div>
    <div className="flex min-h-4 items-center justify-between gap-3 text-xs text-muted-foreground">
      {loading ? <span className="h-3 w-32 animate-pulse rounded bg-muted" /> : <span>{used === undefined ? "Not currently applied" : `Used ${used}%`}</span>}
      {!loading && countdown && <span>resets in {countdown}</span>}
    </div>
    {!loading && stale && <p className="text-xs text-amber-600 dark:text-amber-400">Data may be stale</p>}
  </div>
}

export function CodexQuotaTableRow({ accountUsage, loading, error, colSpan, className }: { accountUsage?: AccountUsage; loading: boolean; error?: string; colSpan: number; className?: string }) {
  return <TableRow className={className}>
    <TableCell colSpan={colSpan} className="bg-muted/20 px-4 py-3">
      {error && <p className="mb-3 text-xs text-destructive">Usage unavailable: {error}</p>}
      {accountUsage?.error && !accountUsage.stale && <p className="mb-3 text-xs text-destructive">Usage unavailable: {accountUsage.error}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <QuotaLine label="5 hour" quota={accountUsage?.fiveHour} loading={loading} stale={Boolean(accountUsage?.stale)} />
        <QuotaLine label="Weekly" quota={accountUsage?.weekly} loading={loading} stale={Boolean(accountUsage?.stale)} />
      </div>
    </TableCell>
  </TableRow>
}
