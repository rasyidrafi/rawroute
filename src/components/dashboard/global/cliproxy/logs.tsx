import { LogLinesSkeleton } from "@/components/loading-layout"
import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { apiDelete, fetcher } from "@/components/dashboard/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Confirmation } from "./confirmation"

export function EngineLogs() {
  const [paused, setPaused] = useState(false)
  const [search, setSearch] = useState("")
  const [confirm, setConfirm] = useState(false)
  const [pending, setPending] = useState(false)
  const { data, error, mutate } = useSWR<unknown>("/api/admin/cliproxy/logs?limit=500", fetcher, { refreshInterval: paused ? 0 : 5000, revalidateOnFocus: !paused })
  const content = JSON.stringify(data ?? {}, null, 2).split("\n").filter(line => line.toLowerCase().includes(search.toLowerCase())).join("\n")
  async function clear() {
    setPending(true)
    try { await apiDelete("/api/admin/cliproxy/logs"); await mutate(); setConfirm(false); toast.success("CLIProxy logs cleared") }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : "Unable to clear logs") }
    finally { setPending(false) }
  }
  return <Card><CardHeader><CardTitle>CLIProxy logs</CardTitle><CardDescription>Engine logs across all workspaces, with secret redaction. Lifecycle events appear in System Logs.</CardDescription></CardHeader><CardContent><div className="space-y-4">
    <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setPaused(value => !value)}>{paused ? "Resume engine logs" : "Pause engine logs"}</Button><Button variant="outline" onClick={() => void mutate()}>Refresh engine logs</Button><Button variant="outline" onClick={() => void navigator.clipboard.writeText(content).then(() => toast.success("Engine logs copied")).catch(() => toast.error("Unable to copy logs"))}>Copy engine logs</Button><Button variant="outline" disabled={pending} onClick={() => setConfirm(true)}>Clear engine logs</Button></div>
    <Input aria-label="Search engine logs" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search engine logs" />
    {error && <p role="alert">Engine logs are unavailable. Check service health and file logging in Settings.</p>}
    <ScrollArea className="h-72">{data === undefined && !error ? <LogLinesSkeleton /> : <pre aria-label="CLIProxy log entries" className="whitespace-pre-wrap break-all font-mono text-xs">{content}</pre>}</ScrollArea>
    <Confirmation title={confirm ? "Clear CLIProxy engine logs?" : null} description="This clears engine log history for every workspace. RawRoute Console Log and System Logs are retained." pending={pending} onClose={() => setConfirm(false)} onConfirm={() => void clear()} />
  </div></CardContent></Card>
}
