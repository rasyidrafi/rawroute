import { EmptyState } from "@rawroute/ui/empty-state"
import { DatabaseIcon } from "lucide-react"

export function UsageEmptyState({ partial }: { partial?: boolean }) {
  return <EmptyState title={partial ? "Usage unavailable" : "No usage yet"} description={partial ? "Coverage is incomplete for this range; no complete usage total can be shown." : "No gateway activity was recorded for this range."} icon={DatabaseIcon} />
}
