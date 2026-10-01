import { LinkIcon } from "lucide-react"

import { LoadingSpinner } from "@/components/loading-spinner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { useCodexLogin } from "@/hooks/use-codex-login"

export function CodexLoginDialog({ login }: { login: ReturnType<typeof useCodexLogin> }) {
  const { device, accountName, setAccountName, polling, callbackUrl, setCallbackUrl, submittingCallback, cancel, submitCallback } = login
  return <Dialog open={Boolean(device)} onOpenChange={(open) => { if (!open) cancel() }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Connect Codex account</DialogTitle>
        <DialogDescription>Sign in, then copy the localhost URL from the browser address bar and paste it below. The localhost page may fail to load; that is expected.</DialogDescription>
      </DialogHeader>
      {device && <div className="grid gap-4 py-2">
        <div className="grid gap-2">
          <label htmlFor="codex-account-name" className="text-sm font-medium">Account label <span className="font-normal text-muted-foreground">(optional)</span></label>
          <Input id="codex-account-name" value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="Work Codex" maxLength={80} />
        </div>
        <div className="rounded-lg border bg-muted/20 p-4 text-center">
          <Button nativeButton={false} size="sm" variant="outline" render={<a href={device.authorizationUrl} target="_blank" rel="noreferrer" aria-label="Open Codex sign-in" />}><LinkIcon />Open Codex sign-in</Button>
        </div>
        <div className="grid gap-2">
          <label htmlFor="codex-callback-url" className="text-sm font-medium">Redirect URL</label>
          <div className="flex gap-2">
            <Input id="codex-callback-url" value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder="http://localhost:1455/auth/callback?code=...&state=..." />
            <Button aria-busy={submittingCallback} disabled={!callbackUrl.trim() || submittingCallback} onClick={() => void submitCallback()}>{submittingCallback && <LoadingSpinner />}Submit</Button>
          </div>
          <p className="text-xs text-muted-foreground">{polling ? "Waiting for the pasted callback…" : "Login paused."}</p>
        </div>
      </div>}
      <DialogFooter><Button variant="outline" onClick={cancel}>Cancel</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
