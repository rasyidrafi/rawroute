import { useState } from "react"
import { toast } from "sonner"
import { useSWRConfig } from "swr"
import { apiFetch, apiPost, ApiRequestError } from "@/components/dashboard/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

type Login = { provider: string; state: string; url: string; userCode?: string }
const providers = ["anthropic", "codex", "antigravity", "kimi", "xai"] as const
export function GlobalOauth() {
  const [login, setLogin] = useState<Login | null>(null)
  const [callback, setCallback] = useState("")
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState("")
  const { mutate } = useSWRConfig()
  async function start(provider: string) {
    setPending(true)
    try {
      const data = await apiFetch<Record<string, unknown>>(`/api/admin/cliproxy/oauth/${provider}/start`, { method: "POST" })
      const url = data.verification_url ?? data.verificationUri ?? data.url
      if (typeof data.state !== "string" || typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("Invalid authorization response")
      setLogin({ provider, state: data.state, url, userCode: typeof data.user_code === "string" ? data.user_code : typeof data.userCode === "string" ? data.userCode : undefined }); setCallback(""); setStatus("Awaiting authorization")
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "OAuth operation failed") }
    finally { setPending(false) }
  }
  async function poll() {
    if (!login) return
    setPending(true)
    try {
      const result = await apiFetch<{ status?: string }>(`/api/admin/cliproxy/oauth/status?state=${encodeURIComponent(login.state)}`)
      setStatus(result.status || "pending")
      if (result.status === "ok") { setLogin(null); toast.success("Global account connected"); await mutate("/api/admin/cliproxy/auth-files") }
      else if (["error", "failed", "cancelled", "canceled", "expired"].includes(result.status || "")) { setLogin(null); toast.error("Authorization ended. Start a new login.") }
    } catch (cause) { handleError(cause, "OAuth status failed") }
    finally { setPending(false) }
  }
  function handleError(cause: unknown, fallback: string) {
    if (cause instanceof ApiRequestError && cause.status === 410) {
      setLogin(null); setCallback(""); setStatus("")
      toast.error("Authorization expired. Start a new login.")
    } else toast.error(cause instanceof Error ? cause.message : fallback)
  }
  async function cancel() {
    if (!login) return
    setPending(true)
    try { await apiFetch(`/api/admin/cliproxy/oauth/cancel?state=${encodeURIComponent(login.state)}`, { method: "POST" }); setLogin(null) }
    catch (cause) { handleError(cause, "OAuth cancellation failed") }
    finally { setPending(false) }
  }
  async function submit() {
    if (!login) return
    setPending(true)
    try {
      const url = new URL(callback)
      const state = url.searchParams.get("state"), code = url.searchParams.get("code"), error = url.searchParams.get("error") || url.searchParams.get("error_description")
      if (state !== login.state || !code && !error) throw new Error("Paste the callback URL for this authorization.")
      await apiPost(`/api/admin/cliproxy/oauth/${login.provider}/callback`, { state, ...(code ? { code } : { error }) }); await poll()
    } catch (cause) { handleError(cause, "OAuth operation failed") }
    finally { setPending(false) }
  }
  return <Card><CardHeader><CardTitle>Global OAuth</CardTitle><CardDescription>Connect global engine accounts. Use workspace Codex Providers to connect accounts for workspace routing.</CardDescription></CardHeader><CardContent><div className="flex flex-wrap gap-2">{providers.map(provider => <Button key={provider} variant="outline" disabled={pending || Boolean(login)} onClick={() => void start(provider)}>Connect {provider === "xai" ? "xAI" : provider}</Button>)}</div>
    <Dialog open={Boolean(login)} onOpenChange={open => { if (!open && !pending) void cancel() }}><DialogContent><DialogHeader><DialogTitle>Connect {login?.provider}</DialogTitle><DialogDescription>Complete authorization, then check its status. Closing this dialog cancels the login.</DialogDescription></DialogHeader>
      <p role="status">{status}</p>
      {login?.userCode ? <Field><FieldLabel>Verification code</FieldLabel><Input readOnly value={login.userCode} /></Field> : <Field><FieldLabel htmlFor="cliproxy-callback">Callback URL</FieldLabel><Input id="cliproxy-callback" value={callback} onChange={event => setCallback(event.target.value)} placeholder="Paste the complete callback URL" /></Field>}
      {login && <a href={login.url} target="_blank" rel="noopener noreferrer" className="break-all text-sm underline">Open authorization page</a>}
      <DialogFooter><Button variant="outline" disabled={pending} onClick={() => void cancel()}>Cancel login</Button><Button variant="outline" disabled={pending} onClick={() => void poll()}>Check status</Button>{!login?.userCode && <Button disabled={pending || !callback} onClick={() => void submit()}>Submit callback</Button>}</DialogFooter>
    </DialogContent></Dialog>
  </CardContent></Card>
}
