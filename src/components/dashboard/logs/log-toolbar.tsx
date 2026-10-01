import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { LogLevel } from "@/lib/logging/types"

export function LogToolbar({ level, setLevel, query, setQuery, source, setSource, sources, live, setLive, disabled = false }: {
  disabled?: boolean
  level: LogLevel | "all"; setLevel: (level: LogLevel | "all") => void
  query: string; setQuery: (value: string) => void
  source: string; setSource: (value: string) => void; sources: string[]
  live: boolean; setLive: (value: boolean) => void
}) {
  return <div className="flex shrink-0 flex-col gap-3 border-y py-4 xl:flex-row xl:items-center xl:justify-between">
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex gap-2" aria-label="Log severity">{(["all", "error", "warn", "info"] as const).map(item => <Button disabled={disabled} key={item} size="sm" variant={level === item ? "default" : "outline"} onClick={() => setLevel(item)}>{item === "all" ? "All" : item[0].toUpperCase() + item.slice(1)}</Button>)}</div>
      {sources.length > 1 && <Select disabled={disabled} value={source} onValueChange={value => setSource(value ?? "all")}><SelectTrigger aria-label="Log source"><SelectValue placeholder="All sources" /></SelectTrigger><SelectContent><SelectItem value="all">All sources</SelectItem>{sources.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>}
    </div>
    <div className="flex min-w-0 items-center gap-3 xl:ml-auto xl:w-full xl:max-w-md">
      <Input disabled={disabled} aria-label="Search logs" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search log text..." className="min-w-0 flex-1" />
      <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm"><Checkbox disabled={disabled} checked={live} onCheckedChange={setLive} /><span aria-hidden="true" className={live ? "size-2 rounded-full bg-success" : "size-2 rounded-full bg-muted-foreground"} />{live ? "Live" : "Paused"}</label>
    </div>
  </div>
}
