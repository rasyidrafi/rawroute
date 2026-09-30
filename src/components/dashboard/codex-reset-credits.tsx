"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import type { CodexUsageResult } from "@/lib/codex/usage"
import { formatAppDateTime } from "@/lib/timezone"

export function CodexResetCredits({ usage }: { usage?: CodexUsageResult }) {
  const [now, setNow] = useState(0)
  useEffect(() => {
    const update = () => setNow(Date.now())
    update()
    const timer = setInterval(update, 60000)
    return () => clearInterval(timer)
  }, [])
  const credits = usage?.resetCredits
  const available = credits?.filter((credit) => credit.status === "available" && (!credit.expiresAt || Date.parse(credit.expiresAt) > now))
  const count = available?.length ?? usage?.unusedResetCredits
  const next = available?.find((credit) => credit.expiresAt)
  function remaining(value: string) {
    const hours = Math.max(0, Math.ceil((Date.parse(value) - now) / 3600000))
    return `${Math.floor(hours / 24)}d ${hours % 24}h`
  }
  return <Dialog>
    <DialogTrigger render={<Button variant="ghost" className="h-auto flex-col items-start gap-1 px-2" />}>
      <span>{count === undefined ? "Not Available" : `${count} available`}</span>
      <span className="text-xs text-muted-foreground">{usage?.stale ? "Last known data · " : ""}{next?.expiresAt && now ? `Next expires in ${remaining(next.expiresAt)}` : credits ? "No upcoming expiry" : "Expiry unavailable"}</span>
    </DialogTrigger>
    <DialogContent>
      <DialogHeader><DialogTitle>Reset credits</DialogTitle><DialogDescription>Individual credit expiry dates.{usage?.stale ? " Showing last known data." : ""}</DialogDescription></DialogHeader>
      <div className="max-h-96 space-y-3 overflow-y-auto">
        {!credits ? <p className="text-sm text-muted-foreground">Expiry unavailable. Try again after the next usage refresh.</p> : !credits.length ? <p>No reset credits.</p> : credits.map((credit) => {
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
