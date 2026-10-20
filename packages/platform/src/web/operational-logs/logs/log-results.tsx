import { LogLinesSkeleton } from "@rawroute/ui/loading-layout"
import { EmptyState } from "@rawroute/ui/empty-state"
import { ScrollArea } from "@rawroute/ui/scroll-area"
import { SearchIcon } from "lucide-react"
import type { LogEntry as Entry } from "@rawroute/observability/contracts/types"
import { LogEntry } from "./log-entry"

export function LogResults({ entries, loading, hasError = false }: { entries: Entry[]; loading: boolean; hasError?: boolean }) {
  let content = hasError ? null : <EmptyState title="No matching logs" description="Try changing the search text or log filters." icon={SearchIcon} variant="compact" treatment="embedded" tone="console" />
  if (loading) content = <LogLinesSkeleton />
  else if (entries.length) content = <>{entries.map(entry => <LogEntry key={entry.id} entry={entry} />)}</>
  return <ScrollArea orientation="vertical" variant="console" className="min-h-0 flex-1"><div className="font-mono text-xs" aria-label="Console log entries" aria-busy={loading}>{content}</div></ScrollArea>
}
