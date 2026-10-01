import { DashboardPage } from "@/components/dashboard/page-layout"
import { useCodexLogin } from "@/hooks/use-codex-login"
import { CodexLoginDialog } from "@/components/dashboard/codex-login-dialog"
import { useCallback, useState } from "react"
import { LinkIcon, LogInIcon, RotateCcwIcon, Trash2Icon } from "lucide-react"
import useSWR, { useSWRConfig } from "swr"
import { toast } from "sonner"

import { useDashboardApi } from "@/components/dashboard/api-context"
import { CodexResetCredits } from "@/components/dashboard/codex-reset-credits"
import { codexUsageError, CodexQuotaTableCell, type UsageResponse } from "@/components/dashboard/codex-quota"
import { LoadError, ConfirmAction, EmptyRow } from "@/components/dashboard/shared"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { LoadingSpinner } from "@/components/loading-spinner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { TableColumns, Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
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

function expiryLabel(value?: string) {
  if (!value) return "Unknown"
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return "Unknown"
  return formatAppDateTime(date)
}

export function OAuthProvidersView() {
  const { fetcher, apiPatch, apiDelete, apiPost } = useDashboardApi()
  const { mutate: refreshCachedResource } = useSWRConfig()
  const { data, error, isLoading, isValidating, mutate } = useSWR<OAuthResponse>("/api/admin/oauth-providers", fetcher)
  const { data: usageData, error: usageError, isLoading: usageLoading, mutate: mutateUsage } = useSWR<UsageResponse>("/api/admin/oauth-providers/usage", fetcher, {
    refreshInterval: 300000,
    dedupingInterval: 300000,
    revalidateOnFocus: false,
  })
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const [resetAccount, setResetAccount] = useState<Account | null>(null)
  const [resetConfirmation, setResetConfirmation] = useState("")

  const onConnected = useCallback(() => Promise.all([mutate(), mutateUsage(), refreshCachedResource("/api/admin/providers")]), [mutate, mutateUsage, refreshCachedResource])
  const login = useCodexLogin(onConnected)
  const { device, starting, connect } = login

  if (error) return <LoadError title="OAuth providers unavailable" error={error} retrying={isValidating} onRetry={() => void mutate()} />
  if (isLoading || !data) return <DashboardContentSkeleton variant="oauth-providers" />

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

  return <DashboardPage>
      <Card>
        <CardHeader>
          <CardTitle variant="icon"><LinkIcon className="size-5" />Codex Providers</CardTitle>
          <CardDescription>Connect multiple Codex accounts once and route native Responses requests through this gateway. Usage limits update every five minutes.</CardDescription>
          <CardAction><Button aria-busy={starting} onClick={() => void connect()} disabled={starting || Boolean(device)}>{starting ? <LoadingSpinner /> : <LogInIcon />}Add Codex account</Button></CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableColumns columns={[{ id: "Account", label: "Account" }, { id: "Plan", label: "Plan" }, { id: "Status", label: "Status" }, { id: "Usage Limits", label: "Usage Limits" }, { id: "Unused Resets", label: "Unused Resets" }, { id: "Token expiry", label: "Token expiry" }, { id: "Actions", label: "Actions", className: "text-right" }]} />
            <TableBody>
              {data.accounts.map((account) => {
                const updateKey = `update:${account.id}`
                const usage = usageData?.accounts[account.id]
                const rowError = account.cliProxyStatusMessage && ["missing", "error", "expired", "unavailable"].includes(account.cliProxyStatus || "") ? account.cliProxyStatusMessage : codexUsageError(usage, usageError?.message)
                if (rowError) return <TableRow key={account.id} variant="error">
                  <TableCell colSpan={6} density="comfortable"
                          className="whitespace-normal"><div className="flex min-w-0 flex-col gap-1"><span className="font-medium text-destructive">{account.name}</span><span className="break-words text-sm text-destructive">{rowError}</span></div></TableCell>
                  <TableCell><div className="flex justify-end"><ConfirmAction title={`Remove ${account.name}?`} description={account.credentialKind === "codex-cli-proxy" ? "This deletes the CLIProxy OAuth credential. You can reconnect this account afterward." : "This removes the unmatched legacy credential from RawRoute."} pending={pending.has(`delete:${account.id}`)} onConfirm={() => removeAccount(account)}><Trash2Icon /></ConfirmAction></div></TableCell>
                </TableRow>
                return <TableRow key={account.id} variant={account.enabled ? "default" : "disabled"}>
                    <TableCell><div className="font-medium">{account.name}</div><div className="text-xs text-muted-foreground">{account.email || account.accountId || "Codex account"}</div></TableCell>
                    <TableCell><Badge variant="secondary">{account.planType ? account.planType.charAt(0).toUpperCase() + account.planType.slice(1) : "Codex"}</Badge></TableCell>
                    <TableCell><Badge variant={account.enabled ? "secondary" : "outline"} title={account.cliProxyStatusMessage}>{account.cliProxyStatus === "missing" ? "Reconnect required" : account.enabled ? "Enabled" : "Disabled"}</Badge></TableCell>
                    <CodexQuotaTableCell accountUsage={usage} loading={usageLoading && !usageData} error={usageError?.message} routingStatus={account.cliProxyStatusMessage} />
                    <TableCell>{usageLoading && !usageData ? "…" : <CodexResetCredits usage={usage} />}</TableCell>
                    <TableCell text="small" tone="muted">{expiryLabel(account.expiresAt)}</TableCell>
                    <TableCell><div className="flex justify-end gap-1"><Button aria-busy={pending.has(updateKey)} size="sm" variant="outline" disabled={pending.has(updateKey) || account.credentialKind !== "codex-cli-proxy"} onClick={() => void updateAccount(account, !account.enabled)}>{pending.has(updateKey) ? <LoadingSpinner /> : account.enabled ? "Disable" : "Enable"}</Button>{account.credentialKind === "codex-cli-proxy" && (usage?.unusedResetCredits ?? 0) > 0 && <Button aria-busy={pending.has(`reset:${account.id}`)} size="sm" variant="outline" disabled={usage?.weekly?.remainingPercent !== 0 || pending.has(`reset:${account.id}`)} title="Requires an exhausted weekly quota" onClick={() => setResetAccount(account)}>{pending.has(`reset:${account.id}`) ? <LoadingSpinner /> : <RotateCcwIcon />}Redeem</Button>}<ConfirmAction title={`Remove ${account.name}?`} description={account.credentialKind === "codex-cli-proxy" ? "This deletes the CLIProxy OAuth credential. You can connect this account again later." : "This removes the unmatched legacy credential from RawRoute. Reconnect it to use this account again."} pending={pending.has(`delete:${account.id}`)} onConfirm={() => removeAccount(account)}><Trash2Icon /></ConfirmAction></div></TableCell>
                  </TableRow>
              })}
              {!data.accounts.length && <EmptyRow label="No Codex accounts connected yet." colSpan={7} />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    <CodexLoginDialog login={login} />
    <AlertDialog open={Boolean(resetAccount)} onOpenChange={(open) => { if (!open) { setResetAccount(null); setResetConfirmation("") } }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Redeem Codex reset credit?</AlertDialogTitle><AlertDialogDescription>This consumes one banked reset credit for {resetAccount?.name}. Type <code>use my codex reset</code> to confirm.</AlertDialogDescription></AlertDialogHeader>
        <Input value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} placeholder="use my codex reset" autoFocus />
        <AlertDialogFooter><AlertDialogCancel disabled={pending.has(`reset:${resetAccount?.id}`)}>Cancel</AlertDialogCancel><AlertDialogAction aria-busy={pending.has(`reset:${resetAccount?.id}`)} disabled={!resetConfirmation.toLowerCase().includes("use my codex reset") || pending.has(`reset:${resetAccount?.id}`)} onClick={() => { if (resetAccount) void redeemReset(resetAccount) }}>{pending.has(`reset:${resetAccount?.id}`) && <LoadingSpinner />}Redeem reset</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </DashboardPage>
}
