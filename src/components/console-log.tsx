"use client"

import { useMemo, useState } from "react"
import { ClipboardIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import useSWR from "swr"
import { toast } from "sonner"

import { LoadingSpinner } from "@/components/loading-spinner"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { LogEntry, LogLevel } from "@/lib/logger"

async function fetchLogs(url: string) {
  const response = await fetch(url, { cache: "no-store" })
  if (response.status === 401) { window.location.assign("/login"); throw new Error("Unauthorized") }
  if (!response.ok) throw new Error("Unable to load console logs")
  return response.json() as Promise<{ logs: LogEntry[] }>
}

function formatLog(entry: LogEntry) {
  const details = entry.details ? ` ${Object.entries(entry.details).map(([key, value]) => `${key}=${value}`).join(" ")}` : ""
  return `${entry.timestamp} ${entry.level.toUpperCase().padEnd(5)} [${entry.source}] ${entry.message}${details}`
}

export function ConsoleLog() {
  const [live, setLive] = useState(true)
  const [query, setQuery] = useState("")
  const [level, setLevel] = useState<LogLevel | "all">("all")
  const [clearing, setClearing] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const { data, error, isLoading, isValidating, mutate } = useSWR("/api/admin/logs", fetchLogs, { refreshInterval: live ? 3000 : 0, revalidateOnFocus: false })
  const logs = useMemo(() => (data?.logs || []).filter((entry) => (level === "all" || entry.level === level) && formatLog(entry).toLowerCase().includes(query.toLowerCase())), [data, level, query])

  async function clear() {
    setClearing(true)
    try {
      const response = await fetch("/api/admin/logs", { method: "DELETE" })
      if (!response.ok) throw new Error("Unable to clear logs")
      await mutate()
      setClearOpen(false)
      toast.success("Console logs cleared")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to clear logs") } finally { setClearing(false) }
  }

  return <main className="h-[calc(100svh-var(--header-height))] max-h-[calc(100svh-var(--header-height))] min-h-0 flex-none overflow-hidden bg-[#f6f5f1] p-4 dark:bg-background md:h-[calc(100svh-var(--header-height)-1rem)] md:max-h-[calc(100svh-var(--header-height)-1rem)] md:p-6 lg:p-8"><div className="mx-auto h-full max-w-7xl"><Card className="h-full"><CardHeader><CardTitle>Console Log</CardTitle><CardDescription>Recent gateway, authentication, and dashboard activity from this running instance.</CardDescription><CardAction><div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => void mutate()} disabled={isValidating}>{isValidating ? <LoadingSpinner /> : <RefreshCwIcon />}Refresh</Button><Button variant="outline" disabled={!logs.length} onClick={() => { void navigator.clipboard.writeText(logs.map(formatLog).join("\n")); toast.success("Logs copied") }}><ClipboardIcon />Copy</Button><Button variant="outline" disabled={!data?.logs.length} onClick={() => setClearOpen(true)}><Trash2Icon />Clear</Button></div></CardAction></CardHeader><CardContent className="flex min-h-0 flex-1 flex-col gap-4"><div className="flex shrink-0 flex-col gap-3 border-y py-4 lg:flex-row lg:items-center"><div className="flex flex-wrap gap-2">{(["all", "error", "warn", "info"] as const).map((item) => <Button key={item} size="sm" variant={level === item ? "default" : "outline"} onClick={() => setLevel(item)}>{item === "all" ? "All" : item[0].toUpperCase() + item.slice(1)}</Button>)}</div><div className="flex flex-1 items-center gap-3 lg:justify-end"><Input aria-label="Search logs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search log text..." className="max-w-sm" /><label className="flex shrink-0 items-center gap-2 text-sm"><Checkbox checked={live} onCheckedChange={setLive} /><span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-emerald-500" />Live</span></label></div></div><ScrollArea className="min-h-0 flex-1 rounded-lg bg-slate-950" contentClassName="p-4 font-mono text-xs leading-6 text-slate-200">{isLoading && <div className="flex items-center gap-2 text-slate-400"><LoadingSpinner />Loading logs...</div>}{error && <div className="text-red-400">{error.message}</div>}{!isLoading && !error && !logs.length && <div className="text-slate-500">No matching logs.</div>}{logs.map((entry) => <div key={entry.id} className="flex gap-3 border-b border-white/5 py-1 last:border-0"><span className="shrink-0 text-slate-500">{new Date(entry.timestamp).toLocaleTimeString()}</span><Badge variant="outline" className={entry.level === "error" ? "border-red-500/40 text-red-400" : entry.level === "warn" ? "border-amber-500/40 text-amber-400" : "border-sky-500/40 text-sky-400"}>{entry.level}</Badge><span className="min-w-0 break-words"><span className="text-slate-500">[{entry.source}]</span> {entry.message}{entry.details && <span className="text-slate-400"> {Object.entries(entry.details).map(([key, value]) => `${key}=${value}`).join(" ")}</span>}</span></div>)}</ScrollArea></CardContent></Card></div><AlertDialog open={clearOpen} onOpenChange={setClearOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Clear console logs?</AlertDialogTitle><AlertDialogDescription>This removes the in-memory log history for this running instance.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={clearing}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={clearing} onClick={() => void clear()}>{clearing && <LoadingSpinner />}Clear logs</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></main>
}
