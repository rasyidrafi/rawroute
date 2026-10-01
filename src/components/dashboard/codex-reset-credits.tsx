import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import type { CodexUsageResult } from "@/lib/codex/usage"
import { formatAppDateTime } from "@/lib/timezone"

export function getCodexResetCreditSummary(usage: CodexUsageResult | undefined, now: number) {
  const available = usage?.resetCredits?.filter((credit) => credit.status === "available" && (!credit.expiresAt || Date.parse(credit.expiresAt) > now))
  const nextExpiry = available?.reduce<string | undefined>((earliest, credit) => {
    if (!credit.expiresAt) return earliest
    return !earliest || Date.parse(credit.expiresAt) < Date.parse(earliest) ? credit.expiresAt : earliest
  }, undefined)
  return { available, count: available?.length ?? usage?.unusedResetCredits, nextExpiry }
}

export function CodexResetCredits({ usage }: { usage?: CodexUsageResult }) {
  const [now, setNow] = useState(0)
  useEffect(() => {
    const update = () => setNow(Date.now())
    update()
    const timer = setInterval(update, 60000)
    return () => clearInterval(timer)
  }, [])
  const credits = usage?.resetCredits
  const { count, nextExpiry } = getCodexResetCreditSummary(usage, now)
  function remaining(value: string) {
    const hours = Math.max(0, Math.ceil((Date.parse(value) - now) / 3600000))
    return `${Math.floor(hours / 24)}d ${hours % 24}h`
  }
  return <Dialog>
    <DialogTrigger render={<Button variant="ghost" size="compact"
            className="h-auto flex-col items-start" />}>
      <span>{count === undefined ? "Not Available" : `${count} available`}</span>
      <span className="text-xs text-muted-foreground">{usage?.stale ? "Last known data · " : ""}{nextExpiry ? now ? `Next expires in ${remaining(nextExpiry)}` : "Next expiry available" : credits ? "No upcoming expiry" : "Expiry unavailable"}</span>
    </DialogTrigger>
    <DialogContent>
      <DialogHeader><DialogTitle>Reset credits</DialogTitle><DialogDescription>Individual credit expiry dates.{usage?.stale ? " Showing last known data." : ""}</DialogDescription></DialogHeader>
      <div className="max-h-96 space-y-3 overflow-y-auto">
        {!credits ? <p className="text-sm text-muted-foreground">{usage?.resetCreditsError || "Expiry unavailable. Try again after the next usage refresh."}</p> : !credits.length ? <p>No reset credits.</p> : credits.map((credit) => {
          const expired = credit.expiresAt && now > Date.parse(credit.expiresAt)
          return <div key={credit.id} className="rounded-lg border p-3 text-sm">
            <p className="font-medium capitalize">{expired && credit.status === "available" ? "expired" : credit.status}</p>
            <p>Granted: {credit.grantedAt ? formatAppDateTime(new Date(credit.grantedAt)) : "Unknown"}</p>
            <p>Expires: {credit.expiresAt ? formatAppDateTime(new Date(credit.expiresAt)) : "No expiry reported"}</p>
            {credit.expiresAt && !expired && now > 0 && credit.status === "available" && <p className="text-muted-foreground">{remaining(credit.expiresAt)} remaining</p>}
          </div>
        })}
      </div>
    </DialogContent>
  </Dialog>
}
