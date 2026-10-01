import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { LogLevel } from "@/lib/logging/types"

export function LogToolbar({ level, setLevel, query, setQuery, source, setSource, sources, live, setLive }: {
  level: LogLevel | "all"; setLevel: (level: LogLevel | "all") => void
  query: string; setQuery: (value: string) => void
  source: string; setSource: (value: string) => void; sources: string[]
  live: boolean; setLive: (value: boolean) => void
}) {
  return <div className="flex shrink-0 flex-wrap items-center gap-3 border-y py-4">
    <div className="flex gap-2" aria-label="Log severity">{(["all", "error", "warn", "info"] as const).map(item => <Button key={item} size="sm" variant={level === item ? "default" : "outline"} onClick={() => setLevel(item)}>{item === "all" ? "All" : item[0].toUpperCase() + item.slice(1)}</Button>)}</div>
    <Select value={source} onValueChange={value => setSource(value ?? "all")}><SelectTrigger aria-label="Log source"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All sources</SelectItem>{sources.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
    <Input aria-label="Search logs" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search log text..." className="max-w-sm" />
    <label className="flex items-center gap-2 text-sm"><Checkbox checked={live} onCheckedChange={setLive} />Live</label>
  </div>
}
