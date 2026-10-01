import { LogLinesSkeleton } from "@/components/loading-layout"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { LogEntry as Entry, LogSnapshot } from "@/lib/logging/types"
import { LogEntry } from "./log-entry"

export function LogResults({ entries, loading }: { entries: Entry[]; loading: boolean }) {
  let content = <p>No matching logs.</p>
  if (loading) content = <LogLinesSkeleton />
  else if (entries.length) content = <>{entries.map(entry => <LogEntry key={entry.id} entry={entry} />)}</>
  return <ScrollArea orientation="vertical" variant="console" className="min-h-0 flex-1"><div className="font-mono text-xs" aria-label="Console log entries" aria-busy={loading}>{content}</div></ScrollArea>
}

export function LogStatus({ count, snapshot, live }: { count: number; snapshot: LogSnapshot | null; live: boolean }) {
  const total = snapshot?.entries.length ?? 0
  const capacity = snapshot?.capacity ?? 2000
  const evicted = snapshot?.evicted ? ` · ${snapshot.evicted} older entries expired` : ""
  return <p className="py-2 text-xs text-muted-foreground" role="status">{count} of {total} entries · newest first · capacity {capacity}{evicted}{live ? " · Refreshes every 3 seconds" : " · Paused"}</p>
}
