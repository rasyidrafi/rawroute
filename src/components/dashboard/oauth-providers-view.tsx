"use client"

import { useEffect, useState } from "react"
import { LinkIcon, LogInIcon, RotateCcwIcon, Trash2Icon } from "lucide-react"
import useSWR, { useSWRConfig } from "swr"
import { toast } from "sonner"

import { apiDelete, apiPatch, apiPost, fetcher } from "@/components/dashboard/api"
import { codexUsageError, CodexQuotaTableCell, type UsageResponse } from "@/components/dashboard/codex-quota"
import { ConfirmAction, EmptyRow } from "@/components/dashboard/shared"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { LoadingSpinner } from "@/components/loading-spinner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatAppDateTime } from "@/lib/timezone"

type Account = {
  id: string
  name: string
  email?: string
  accountId?: string
  planType?: string
  enabled: boolean
  expiresAt?: string
  lastRefresh?: string
  credentialKind?: "codex-oauth" | "codex-cli-proxy"
  cliProxyStatus?: string
  cliProxyStatusMessage?: string
}

type OAuthResponse = {
  provider: { id: string; name: string; prefix: string; baseUrl: string } | null
  accounts: Account[]
}

type DeviceCode = {
  loginId: string
  authorizationUrl: string
}

function expiryLabel(value?: string) {
  if (!value) return "Unknown"
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return "Unknown"
  return formatAppDateTime(date)
}

export function OAuthProvidersView() {
  const { mutate: refreshCachedResource } = useSWRConfig()
  const { data, error, isLoading, isValidating, mutate } = useSWR<OAuthResponse>("/api/admin/oauth-providers", fetcher)
  const { data: usageData, error: usageError, isLoading: usageLoading, mutate: mutateUsage } = useSWR<UsageResponse>("/api/admin/oauth-providers/usage", fetcher, {
    refreshInterval: 300000,
    dedupingInterval: 300000,
    revalidateOnFocus: false,
  })
  const [device, setDevice] = useState<DeviceCode | null>(null)
  const [accountName, setAccountName] = useState("")
  const [polling, setPolling] = useState(false)
  const [starting, setStarting] = useState(false)
  const [callbackUrl, setCallbackUrl] = useState("")
  const [submittingCallback, setSubmittingCallback] = useState(false)
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const [resetAccount, setResetAccount] = useState<Account | null>(null)
  const [resetConfirmation, setResetConfirmation] = useState("")

  useEffect(() => {
    if (!device || !polling) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const result = await apiPost<{ status: "pending" | "authorized"; account?: Account }>("/api/admin/oauth-providers/codex/device/poll", {
          loginId: device.loginId,
          name: accountName.trim() || undefined,
        })
        if (stopped) return
        if (result.status === "authorized") {
          setPolling(false)
          setDevice(null)
          setAccountName("")
          await Promise.all([mutate(), mutateUsage(), refreshCachedResource("/api/admin/providers")])
          toast.success("Codex account connected")
          return
        }
        timer = setTimeout(poll, 3000)
      } catch (pollError) {
        if (!stopped) {
          setPolling(false)
          toast.error(pollError instanceof Error ? pollError.message : "Codex login failed")
        }
      }
    }
    timer = setTimeout(poll, 3000)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [accountName, device, mutate, mutateUsage, polling, refreshCachedResource])

  if (error) return <main className="grid min-h-[calc(100svh-var(--header-height))] place-items-center p-6 text-center"><div><p className="font-medium">OAuth providers unavailable</p><p className="mt-2 text-sm text-muted-foreground">{error.message}</p><Button aria-busy={isValidating} className="mt-4" disabled={isValidating} onClick={() => void mutate()}>{isValidating && <LoadingSpinner />}Try again</Button></div></main>
  if (isLoading || !data) return <DashboardContentSkeleton variant="oauth-providers" />

  async function connectCodex() {
    setStarting(true)
    try {
      const nextDevice = await apiPost<DeviceCode>("/api/admin/oauth-providers/codex/device/start", {})
      setDevice(nextDevice)
      setCallbackUrl("")
      setPolling(true)
    } catch (startError) {
      toast.error(startError instanceof Error ? startError.message : "Unable to start Codex login")
    } finally {
      setStarting(false)
    }
  }

  function cancelCodexLogin() {
    if (device) void apiPost("/api/admin/oauth-providers/codex/device/cancel", { loginId: device.loginId }).catch(() => undefined)
    setPolling(false)
    setDevice(null)
    setCallbackUrl("")
  }

  async function submitCallback() {
    if (!device) return
    setSubmittingCallback(true)
    try {
      await apiPost("/api/admin/oauth-providers/codex/device/callback", { loginId: device.loginId, redirectUrl: callbackUrl })
      toast.success("Callback accepted. Finishing Codex login…")
    } catch (callbackError) {
      toast.error(callbackError instanceof Error ? callbackError.message : "Unable to submit callback URL")
    } finally {
      setSubmittingCallback(false)
    }
  }

  async function updateAccount(account: Account, enabled: boolean) {
    const key = `update:${account.id}`
    setPending((current) => new Set(current).add(key))
    try {
      await apiPatch(`/api/admin/oauth-providers/${account.id}`, { enabled })
      await Promise.all([mutate(), refreshCachedResource("/api/admin/providers")])
      toast.success(enabled ? "Account enabled" : "Account disabled")
    } catch (updateError) {
      toast.error(updateError instanceof Error ? updateError.message : "Unable to update account")
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(key); return next })
    }
  }

  async function removeAccount(account: Account) {
    const key = `delete:${account.id}`
    setPending((current) => new Set(current).add(key))
    try {
      await apiDelete(`/api/admin/oauth-providers/${account.id}`)
      await Promise.all([mutate(), refreshCachedResource("/api/admin/providers")])
      toast.success("Codex account removed")
      return true
    } catch (removeError) {
      toast.error(removeError instanceof Error ? removeError.message : "Unable to remove account")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(key); return next })
    }
  }

  async function redeemReset(account: Account) {
    const key = `reset:${account.id}`
    setPending((current) => new Set(current).add(key))
    try {
      await apiPost(`/api/admin/oauth-providers/${account.id}/reset`, { confirmation: resetConfirmation })
      await mutateUsage()
      setResetAccount(null)
      setResetConfirmation("")
      toast.success("Codex reset credit redeemed")
    } catch (resetError) {
      toast.error(resetError instanceof Error ? resetError.message : "Unable to redeem reset credit")
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(key); return next })
    }
  }

  return <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
    <div className="mx-auto flex max-w-7xl flex-col gap-8">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><LinkIcon className="size-5" />Codex Providers</CardTitle>
          <CardDescription>Connect multiple Codex accounts once and route native Responses requests through this gateway. Usage limits update every five minutes.</CardDescription>
          <CardAction><Button aria-busy={starting} onClick={() => void connectCodex()} disabled={starting || Boolean(device)}>{starting ? <LoadingSpinner /> : <LogInIcon />}Add Codex account</Button></CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Account</TableHead><TableHead>Plan</TableHead><TableHead>Status</TableHead><TableHead>Usage Limits</TableHead><TableHead>Unused Resets</TableHead><TableHead>Token expiry</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.accounts.map((account) => {
                const updateKey = `update:${account.id}`
                const usage = usageData?.accounts[account.id]
                const rowError = account.cliProxyStatusMessage && ["missing", "error", "expired", "unavailable"].includes(account.cliProxyStatus || "") ? account.cliProxyStatusMessage : codexUsageError(usage, usageError?.message)
                if (rowError) return <TableRow key={account.id} className="bg-destructive/5">
                  <TableCell colSpan={6} className="whitespace-normal px-4 py-4"><div className="flex min-w-0 flex-col gap-1"><span className="font-medium text-destructive">{account.name}</span><span className="break-words text-sm text-destructive">{rowError}</span></div></TableCell>
                  <TableCell><div className="flex justify-end"><ConfirmAction title={`Remove ${account.name}?`} description={account.credentialKind === "codex-cli-proxy" ? "This deletes the CLIProxy OAuth credential. You can reconnect this account afterward." : "This removes the unmatched legacy credential from RawRoute."} pending={pending.has(`delete:${account.id}`)} onConfirm={() => removeAccount(account)}><Trash2Icon /></ConfirmAction></div></TableCell>
                </TableRow>
                return <TableRow key={account.id} className={account.enabled ? undefined : "opacity-60"}>
                    <TableCell><div className="font-medium">{account.name}</div><div className="text-xs text-muted-foreground">{account.email || account.accountId || "Codex account"}</div></TableCell>
                    <TableCell><Badge variant="secondary">{account.planType ? account.planType.charAt(0).toUpperCase() + account.planType.slice(1) : "Codex"}</Badge></TableCell>
                    <TableCell><Badge variant={account.enabled ? "secondary" : "outline"} title={account.cliProxyStatusMessage}>{account.cliProxyStatus === "missing" ? "Reconnect required" : account.enabled ? "Enabled" : "Disabled"}</Badge></TableCell>
                    <CodexQuotaTableCell accountUsage={usage} loading={usageLoading && !usageData} error={usageError?.message} />
                    <TableCell>{usageLoading && !usageData ? "…" : (usage?.unusedResetCredits ?? 0) > 0 ? usage?.unusedResetCredits : "Not Available"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{expiryLabel(account.expiresAt)}</TableCell>
                    <TableCell><div className="flex justify-end gap-1"><Button aria-busy={pending.has(updateKey)} size="sm" variant="outline" disabled={pending.has(updateKey) || account.credentialKind !== "codex-cli-proxy"} onClick={() => void updateAccount(account, !account.enabled)}>{pending.has(updateKey) ? <LoadingSpinner /> : account.enabled ? "Disable" : "Enable"}</Button>{account.credentialKind === "codex-cli-proxy" && (usage?.unusedResetCredits ?? 0) > 0 && <Button aria-busy={pending.has(`reset:${account.id}`)} size="sm" variant="outline" disabled={usage?.weekly?.remainingPercent !== 0 || pending.has(`reset:${account.id}`)} title="Requires an exhausted weekly quota" onClick={() => setResetAccount(account)}>{pending.has(`reset:${account.id}`) ? <LoadingSpinner /> : <RotateCcwIcon />}Redeem</Button>}<ConfirmAction title={`Remove ${account.name}?`} description={account.credentialKind === "codex-cli-proxy" ? "This deletes the CLIProxy OAuth credential. You can connect this account again later." : "This removes the unmatched legacy credential from RawRoute. Reconnect it to use this account again."} pending={pending.has(`delete:${account.id}`)} onConfirm={() => removeAccount(account)}><Trash2Icon /></ConfirmAction></div></TableCell>
                  </TableRow>
              })}
              {!data.accounts.length && <EmptyRow label="No Codex accounts connected yet." colSpan={7} />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
    <Dialog open={Boolean(device)} onOpenChange={(open) => { if (!open) cancelCodexLogin() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Connect Codex account</DialogTitle><DialogDescription>Sign in, then copy the localhost URL from the browser address bar and paste it below. The localhost page may fail to load; that is expected.</DialogDescription></DialogHeader>
        {device && <div className="grid gap-4 py-2"><div className="grid gap-2"><label htmlFor="codex-account-name" className="text-sm font-medium">Account label <span className="font-normal text-muted-foreground">(optional)</span></label><Input id="codex-account-name" value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="Work Codex" maxLength={80} /></div><div className="rounded-lg border bg-muted/20 p-4 text-center"><Button nativeButton={false} size="sm" variant="outline" render={<a href={device.authorizationUrl} target="_blank" rel="noreferrer" />}><LinkIcon />Open Codex sign-in</Button></div><div className="grid gap-2"><label htmlFor="codex-callback-url" className="text-sm font-medium">Redirect URL</label><div className="flex gap-2"><Input id="codex-callback-url" value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder="http://localhost:1455/auth/callback?code=...&state=..." /><Button aria-busy={submittingCallback} disabled={!callbackUrl.trim() || submittingCallback} onClick={() => void submitCallback()}>{submittingCallback && <LoadingSpinner />}Submit</Button></div><p className="text-xs text-muted-foreground">{polling ? "Waiting for the pasted callback…" : "Login paused."}</p></div></div>}
        <DialogFooter><Button variant="outline" onClick={cancelCodexLogin}>Cancel</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={Boolean(resetAccount)} onOpenChange={(open) => { if (!open) { setResetAccount(null); setResetConfirmation("") } }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Redeem Codex reset credit?</AlertDialogTitle><AlertDialogDescription>This consumes one banked reset credit for {resetAccount?.name}. Type <code>use my codex reset</code> to confirm.</AlertDialogDescription></AlertDialogHeader>
        <Input value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} placeholder="use my codex reset" autoFocus />
        <AlertDialogFooter><AlertDialogCancel disabled={pending.has(`reset:${resetAccount?.id}`)}>Cancel</AlertDialogCancel><AlertDialogAction aria-busy={pending.has(`reset:${resetAccount?.id}`)} disabled={!resetConfirmation.toLowerCase().includes("use my codex reset") || pending.has(`reset:${resetAccount?.id}`)} onClick={() => { if (resetAccount) void redeemReset(resetAccount) }}>{pending.has(`reset:${resetAccount?.id}`) && <LoadingSpinner />}Redeem reset</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </main>
}
