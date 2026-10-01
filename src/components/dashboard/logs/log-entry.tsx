import { Badge } from "@/components/ui/badge"
import type { LogEntry as Entry } from "@/lib/logging/types"
import { formatAppTime } from "@/lib/timezone"

export function LogEntry({ entry }: { entry: Entry }) {
  return <div className="flex items-start gap-3 border-b py-2 last:border-0">
    <time className="shrink-0 text-muted-foreground" dateTime={entry.timestamp}>{formatAppTime(entry.timestamp)}</time>
    <Badge variant={entry.level === "error" ? "log-error" : entry.level === "warn" ? "log-warning" : "log-info"}>{entry.level}</Badge>
    <div className="min-w-0 break-words">
      <span className="text-muted-foreground">[{entry.source}] </span>{entry.message}
      <div className="text-muted-foreground">event={entry.event} origin={entry.origin}{entry.requestId && ` requestId=${entry.requestId}`}</div>
      {Object.keys(entry.details).length > 0 && <div className="text-muted-foreground">{Object.entries(entry.details).map(([key, value]) => `${key}=${value}`).join(" ")}</div>}
    </div>
  </div>
}
