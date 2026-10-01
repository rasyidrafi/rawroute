import { useState, type FormEvent } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { apiFetch, apiDelete, apiPatch, fetcher } from "@/components/dashboard/api"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Confirmation } from "./confirmation"

type Key = { id: string; value: string; managedTransport: boolean }
export function ManagedKeys() {
  const { data, error, mutate } = useSWR<{ apiKeys: Key[] }>("/api/admin/cliproxy/api-keys", fetcher)
  const [key, setKey] = useState("")
  const [pending, setPending] = useState(false)
  const [revoke, setRevoke] = useState<Key | null>(null)
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true)
    try { await apiFetch("/api/admin/cliproxy/api-keys", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ add: key }) }); setKey(""); await mutate(); toast.success("CLIProxy key added") }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : "Unable to save key") }
    finally { setPending(false) }
  }
  async function remove() {
    if (!revoke) return
    setPending(true)
    try { await apiDelete(`/api/admin/cliproxy/api-keys/${encodeURIComponent(revoke.id)}`); setRevoke(null); await mutate(); toast.success("CLIProxy key revoked") }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : "Unable to revoke key") }
    finally { setPending(false) }
  }
  return <Card><CardHeader><CardTitle>CLIProxy API keys</CardTitle><CardDescription>Internal service keys. The RawRoute transport key is protected; public clients use workspace gateway keys.</CardDescription></CardHeader><CardContent><div className="space-y-4">
    <form onSubmit={add}><Field><FieldLabel htmlFor="cliproxy-new-key">New CLIProxy key</FieldLabel><div className="flex flex-wrap gap-2"><Input id="cliproxy-new-key" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} required maxLength={512} /><Button type="submit" disabled={pending || !key.trim()}>Add key</Button></div></Field></form>
    {error ? <p role="alert">Keys are unavailable. <Button variant="outline" onClick={() => void mutate()}>Retry keys</Button></p> : <Table><TableHeader><TableRow><TableHead>Key</TableHead><TableHead>Role</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>{data?.apiKeys.map(item => <TableRow key={item.id}><TableCell>{item.value}</TableCell><TableCell>{item.managedTransport ? "RawRoute transport" : "CLIProxy key"}</TableCell><TableCell>{!item.managedTransport && <Button variant="ghost" disabled={pending} onClick={() => setRevoke(item)}>Revoke</Button>}</TableCell></TableRow>)}</TableBody></Table>}
    <Confirmation title={revoke ? "Revoke CLIProxy key?" : null} description="Requests using this internal service key will stop authenticating." pending={pending} onClose={() => setRevoke(null)} onConfirm={() => void remove()} />
  </div></CardContent></Card>
}

type AuthFile = { name: string; type?: string; status?: string; disabled?: boolean; managed: boolean; workspaceId: string | null }
export function AuthFiles() {
  const { data, error, mutate } = useSWR<{ files: AuthFile[] }>("/api/admin/cliproxy/auth-files", fetcher, { refreshInterval: 15_000 })
  const [pending, setPending] = useState(false)
  const [remove, setRemove] = useState<AuthFile | null>(null)
  async function update(file: AuthFile, disabled?: boolean) {
    setPending(true)
    try {
      if (disabled === undefined) await apiDelete(`/api/admin/cliproxy/auth-files?name=${encodeURIComponent(file.name)}`)
      else await apiPatch("/api/admin/cliproxy/auth-files", { name: file.name, disabled })
      setRemove(null); await mutate(); toast.success("Auth file updated")
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "Unable to update auth file") }
    finally { setPending(false) }
  }
  return <Card><CardHeader><CardTitle>Authentication files</CardTitle><CardDescription>Workspace-owned accounts are shown for visibility. Manage them from their workspace’s Codex Providers page.</CardDescription></CardHeader><CardContent><div className="space-y-4">
    <Button variant="outline" onClick={() => void mutate()}>Refresh accounts</Button>
    {error ? <p role="alert">Authentication files are unavailable.</p> : <Table><TableHeader><TableRow><TableHead>File</TableHead><TableHead>Provider</TableHead><TableHead>Owner</TableHead><TableHead>Status</TableHead><TableHead>Enabled</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>{data?.files.map(file => <TableRow key={file.name}><TableCell className="max-w-64 break-all whitespace-normal">{file.name}</TableCell><TableCell>{file.type || "Unknown"}</TableCell><TableCell><Badge variant="outline">{file.managed ? "Workspace" : "Global"}</Badge></TableCell><TableCell>{file.status || "Unknown"}</TableCell><TableCell><Checkbox aria-label={`Enable ${file.name}`} checked={!file.disabled} disabled={pending || file.managed} onCheckedChange={enabled => void update(file, !enabled)} /></TableCell><TableCell>{!file.managed && <Button variant="ghost" disabled={pending} onClick={() => setRemove(file)}>Delete</Button>}</TableCell></TableRow>)}</TableBody></Table>}
    {data?.files.length === 0 && <p className="text-sm text-muted-foreground">No authentication files.</p>}
    <Confirmation title={remove ? "Delete global authentication file?" : null} description="This removes the account from CLIProxyAPI. Reconnect the account to use it again." pending={pending} onClose={() => setRemove(null)} onConfirm={() => { if (remove) void update(remove) }} />
  </div></CardContent></Card>
}
