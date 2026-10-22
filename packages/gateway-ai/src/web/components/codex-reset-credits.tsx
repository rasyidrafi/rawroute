import { useEffect, useState } from "react"
import { InfoIcon } from "lucide-react"
import { Button } from "@rawroute/ui/button"
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@rawroute/ui/popover"
import { formatAppDateTime, getAppTimeZone } from "@rawroute/observability/contracts/timezone"
import type { CodexUsageResult } from "../../contracts/codex"

function remainingTime(expiresAt: string, now: number) {
  const minutes = Math.ceil((Date.parse(expiresAt) - now) / 60_000)
  if (minutes <= 0) return "Expired"
  if (minutes < 60) return `${minutes}m remaining`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m remaining`
  return `${Math.floor(hours / 24)}d ${hours % 24}h remaining`
}

function ResetCreditDetails({ usage }: { usage: CodexUsageResult }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const credits = usage.resetCredits?.filter(credit => credit.status === "available")
    .sort((a, b) => (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity))
  return <>
    <PopoverTitle>Unused reset expiry</PopoverTitle>
    <PopoverDescription>Earliest expiry first · {getAppTimeZone()}</PopoverDescription>
    {usage.resetCreditsError || !credits?.length ? <p className="text-muted-foreground">Expiry unavailable</p> : <ul className="max-h-64 space-y-2 overflow-y-auto">
      {credits.map(credit => <li key={credit.id} className="flex flex-col gap-0.5 border-t pt-2">
        {credit.expiresAt && Number.isFinite(Date.parse(credit.expiresAt)) ? <>
          <time dateTime={credit.expiresAt} className="font-medium">{formatAppDateTime(credit.expiresAt)}</time>
          <span className="text-xs text-muted-foreground">{remainingTime(credit.expiresAt, now)}</span>
        </> : <span className="text-muted-foreground">Expiry unavailable</span>}
      </li>)}
    </ul>}
    {usage.stale && <p className="text-xs text-muted-foreground">Usage is from an earlier check.</p>}
  </>
}

export function CodexResetCreditsInfo({ usage }: { usage: CodexUsageResult }) {
  const [open, setOpen] = useState(false)
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger openOnHover render={<Button variant="ghost" size="icon-xs" aria-label="View reset expiry" onFocus={event => {
      if (event.currentTarget.matches(":focus-visible")) setOpen(true)
    }}><InfoIcon /></Button>} />
    <PopoverContent initialFocus={false} finalFocus={false} align="start" className="w-80 max-w-[calc(100vw-2rem)]">
      <ResetCreditDetails usage={usage} />
    </PopoverContent>
  </Popover>
}
