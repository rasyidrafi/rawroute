"use client"

import { useEffect, useState } from "react"
import { ArrowLeftIcon, BoxesIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, KeyRoundIcon, LinkIcon, LogInIcon, PencilIcon, PlusIcon, PowerIcon, RotateCcwIcon, Trash2Icon } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import useSWR, { useSWRConfig } from "swr"
import { toast } from "sonner"

import { ConfirmAction, DetailValue, EmptyRow, NotFoundState } from "@/components/dashboard/shared"
import { apiDelete, apiPatch, apiPost, fetcher } from "@/components/dashboard/api"
import { codexUsageError, CodexQuotaTableCell, type UsageResponse } from "@/components/dashboard/codex-quota"
import { ModelForm } from "@/components/dashboard/model-form"
import { ModelShareButton } from "@/components/dashboard/model-share-button"
import { ProviderApiKeyForm } from "@/components/dashboard/provider-api-key-form"
import { ProviderForm } from "@/components/dashboard/provider-form"
import { Input } from "@/components/ui/input"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { LoadingSpinner } from "@/components/loading-spinner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { protocolLabels, type Model, type Provider, type ProviderApiKey } from "@/lib/types"
import { formatAppDate } from "@/lib/timezone"

type ProviderDetailResponse = { provider: Provider; apiKeys: ProviderApiKey[]; models: Model[] }
const providerKey = (providerId: string) => `/api/admin/providers/${encodeURIComponent(providerId)}`

export function ProviderDetailView({ providerId }: { providerId: string }) {
  const router = useRouter()
  const { mutate: refreshCachedResource } = useSWRConfig()
  const { data, error, isLoading, mutate } = useSWR<ProviderDetailResponse>(providerKey(providerId))
  const usageKey = data && (data.provider.prefix === "codex" || data.apiKeys.some((apiKey) => apiKey.credentialKind === "codex-cli-proxy"))
    ? "/api/admin/oauth-providers/usage"
    : null
  const { data: usageData, error: usageError, isLoading: usageLoading } = useSWR<UsageResponse>(usageKey, fetcher, {
    refreshInterval: 300000,
    dedupingInterval: 300000,
    revalidateOnFocus: false,
  })
  const [providerOpen, setProviderOpen] = useState(false)
  const [providerKeyOpen, setProviderKeyOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [editingProviderApiKey, setEditingProviderApiKey] = useState<ProviderApiKey | null>(null)
  const [editingModel, setEditingModel] = useState<Model | null>(null)
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const [device, setDevice] = useState<{ loginId: string; authorizationUrl: string } | null>(null)
  const [accountName, setAccountName] = useState("")
  const [polling, setPolling] = useState(false)
  const [starting, setStarting] = useState(false)
  const [callbackUrl, setCallbackUrl] = useState("")
  const [submittingCallback, setSubmittingCallback] = useState(false)
  const [resetAccount, setResetAccount] = useState<ProviderApiKey | null>(null)
  const [resetConfirmation, setResetConfirmation] = useState("")
  const [toggleAccount, setToggleAccount] = useState<ProviderApiKey | null>(null)

  useEffect(() => {
    if (!device || !polling) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const result = await apiPost<{ status: "pending" | "authorized" }>("/api/admin/oauth-providers/codex/device/poll", { loginId: device.loginId, name: accountName.trim() || undefined })
        if (stopped) return
        if (result.status === "authorized") { setPolling(false); setDevice(null); setAccountName(""); await mutate(); await refreshCachedResource("/api/admin/providers"); toast.success("Codex account connected"); return }
        timer = setTimeout(poll, 3000)
      } catch (pollError) { if (!stopped) { setPolling(false); toast.error(pollError instanceof Error ? pollError.message : "Codex login failed") } }
    }
    timer = setTimeout(poll, 3000)
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [accountName, device, mutate, polling, refreshCachedResource])

  if (error) return <NotFoundState onBack={() => router.push("/dashboard/providers")} />
  if (isLoading || !data) return <DashboardContentSkeleton variant="provider-detail" />

  const isPending = (key: string) => pending.has(key)

  async function addCodexAccount() {
    setStarting(true)
    try { setDevice(await apiPost("/api/admin/oauth-providers/codex/device/start", {})); setCallbackUrl(""); setPolling(true) }
    catch (startError) { toast.error(startError instanceof Error ? startError.message : "Unable to start Codex login") }
    finally { setStarting(false) }
  }

  function cancelCodexLogin() {
    if (device) void apiPost("/api/admin/oauth-providers/codex/device/cancel", { loginId: device.loginId }).catch(() => undefined)
    setPolling(false)
    setDevice(null)
    setCallbackUrl("")
  }

  async function submitCodexCallback() {
    if (!device) return
    setSubmittingCallback(true)
    try {
      await apiPost("/api/admin/oauth-providers/codex/device/callback", { loginId: device.loginId, redirectUrl: callbackUrl })
      toast.success("Callback accepted. Finishing Codex login…")
    } catch (callbackError) {
      toast.error(callbackError instanceof Error ? callbackError.message : "Unable to submit callback URL")
    } finally { setSubmittingCallback(false) }
  }

  async function redeemReset(account: ProviderApiKey) {
    const pendingKey = `reset:${account.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiPost(`/api/admin/oauth-providers/${account.id}/reset`, { confirmation: resetConfirmation })
      await refreshCachedResource("/api/admin/oauth-providers/usage")
      setResetAccount(null)
      setResetConfirmation("")
      toast.success("Codex reset credit redeemed")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to redeem reset credit")
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }

  async function deleteCodexAccount(account: ProviderApiKey) {
    const pendingKey = `delete-codex-account:${account.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiDelete(`/api/admin/oauth-providers/${account.id}`)
      await Promise.all([mutate(), refreshCachedResource("/api/admin/providers"), refreshCachedResource("/api/admin/oauth-providers/usage")])
      toast.success("Codex account removed")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to remove Codex account")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }

  async function setCodexAccountEnabled(account: ProviderApiKey) {
    const pendingKey = `toggle-codex-account:${account.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiPatch(`/api/admin/oauth-providers/${account.id}`, { enabled: !account.enabled })
      await Promise.all([mutate(), refreshCachedResource("/api/admin/providers"), refreshCachedResource("/api/admin/oauth-providers/usage")])
      toast.success(`Codex account ${account.enabled ? "disabled" : "enabled"}`)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update Codex account")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }

  async function saveProvider(provider: Partial<Provider> & { originalId?: string }) {
    setPending((current) => new Set(current).add("save-provider"))
    try {
      await apiPost("/api/admin/providers", { provider })
      toast.success(editingProvider ? "Provider updated" : "Provider saved")
      await mutate()
      await refreshCachedResource("/api/admin/providers")
      setProviderOpen(false)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete("save-provider"); return next })
    }
  }

  async function deleteProvider(provider: Provider) {
    const pendingKey = `delete-provider:${provider.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiDelete(`/api/admin/providers/${provider.id}`)
      toast.success("Provider deleted")
      await refreshCachedResource("/api/admin/providers")
      router.push("/dashboard/providers")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }

  async function saveProviderApiKey(apiKey: Partial<ProviderApiKey> & { originalId?: string }) {
    setPending((current) => new Set(current).add("save-provider-api-key"))
    try {
      await apiPost(`/api/admin/providers/${provider.id}/api-keys`, { providerApiKey: apiKey })
      toast.success(editingProviderApiKey ? "Provider API key updated" : "Provider API key added")
      await mutate()
      await refreshCachedResource("/api/admin/providers")
      setProviderKeyOpen(false)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete("save-provider-api-key"); return next })
    }
  }

  async function deleteProviderApiKey(apiKey: ProviderApiKey) {
    const pendingKey = `delete-provider-api-key:${apiKey.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiDelete(`/api/admin/providers/${providerId}/api-keys/${apiKey.id}`)
      toast.success("Provider API key deleted")
      await mutate()
      await refreshCachedResource("/api/admin/providers")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }

  async function moveProviderApiKey(index: number, direction: -1 | 1) {
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= apiKeys.length) return
    const orderedIds = apiKeys.map((apiKey) => apiKey.id)
    ;[orderedIds[index], orderedIds[nextIndex]] = [orderedIds[nextIndex], orderedIds[index]]
    const pendingKey = `move-provider-api-key:${apiKeys[index].id}:${direction}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiPost(`/api/admin/providers/${provider.id}/api-keys/reorder`, { orderedIds })
      await mutate()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }

  async function saveModel(model: Partial<Model> & { originalId?: string }) {
    setPending((current) => new Set(current).add("save-model"))
    try {
      await apiPost(`/api/admin/providers/${provider.id}/models`, { model })
      toast.success(editingModel ? "Model updated" : "Model saved")
      await mutate()
      await refreshCachedResource("/api/admin/providers")
      setModelOpen(false)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete("save-model"); return next })
    }
  }

  async function deleteModel(model: Model) {
    const pendingKey = `delete-model:${model.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiDelete(`/api/admin/providers/${provider.id}/models/${encodeURIComponent(model.id)}`)
      toast.success("Model deleted")
      await mutate()
      await refreshCachedResource("/api/admin/providers")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }

  const { provider, apiKeys, models } = data
  const apiKeyCounts = {
    configured: apiKeys.length,
    enabled: apiKeys.filter((apiKey) => apiKey.enabled).length,
  }
  const isOAuthProvider = provider.prefix === "codex" || (apiKeys.length > 0 && apiKeys.every((apiKey) => apiKey.credentialKind === "codex-cli-proxy"))
  const credentialLabel = isOAuthProvider ? (apiKeyCounts.configured === 1 ? "account" : "accounts") : `API ${apiKeyCounts.configured === 1 ? "key" : "keys"}`

  return <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
    <div className="mx-auto flex max-w-7xl flex-col gap-8">
      <div>
        <Button nativeButton={false} variant="ghost" className="-ml-3 mb-3" render={<Link href="/dashboard/providers" prefetch={false} />}><ArrowLeftIcon />Providers</Button>
        <div><h2 className="text-2xl font-semibold tracking-tight">{provider.name}</h2><p className="mt-1 text-sm text-muted-foreground">{apiKeyCounts.configured} {credentialLabel} configured</p></div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Provider details</CardTitle>
          <CardDescription><span className="font-mono">{provider.baseUrl}</span></CardDescription>
          <CardAction>
            <div className="flex gap-2">
              {provider.prefix !== "codex" && <Button size="sm" variant="outline" onClick={() => { setEditingProvider(provider); setProviderOpen(true) }}><PencilIcon />Edit</Button>}
              {provider.prefix !== "codex" && <ConfirmAction buttonLabel="Delete provider" title={`Delete ${provider.name}?`} description={`This permanently deletes ${apiKeyCounts.configured} API keys and ${models.length} models attached to this provider.`} pending={isPending(`delete-provider:${provider.id}`)} onConfirm={() => deleteProvider(provider)}><Trash2Icon /></ConfirmAction>}
            </div>
          </CardAction>
        </CardHeader>
        <Dialog open={providerOpen} onOpenChange={(open) => { setProviderOpen(open); if (!open) setEditingProvider(null) }}>
          <DialogContent>
            <ProviderForm key={editingProvider?.id || "new"} provider={editingProvider} onSave={saveProvider} />
          </DialogContent>
        </Dialog>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(120px,1fr))]">
            <DetailValue label="Gateway prefix" value={`${provider.prefix}/`} mono />
            <DetailValue label="Authentication" value={provider.authType === "none" ? "None" : provider.authType} />
            <DetailValue label="Protocol" value={protocolLabels[provider.protocol]} />
            {provider.protocol !== "anthropic-messages" && <DetailValue label="Prompt cache key" value={provider.supportPromptCacheKey === true ? "Enabled" : "Disabled"} />}
            <DetailValue label={isOAuthProvider ? "Configured accounts" : "Configured keys"} value={String(apiKeyCounts.configured)} />
            <DetailValue label="Configured models" value={String(models.length)} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><KeyRoundIcon className="size-5" />{isOAuthProvider ? "Accounts" : "API keys"}</CardTitle>
          <CardDescription>The account at the top has the highest priority. CLIProxy uses fill-first routing and only falls through when that account is unavailable.</CardDescription>
          <CardAction>{provider.prefix === "codex" ? <Button aria-busy={starting} onClick={() => void addCodexAccount()} disabled={starting || Boolean(device)}>{starting ? <LoadingSpinner /> : <LogInIcon />}Add Codex Account</Button> : <Button disabled={provider.authType === "none"} onClick={() => { setEditingProviderApiKey(null); setProviderKeyOpen(true) }}><PlusIcon />Add API key</Button>}</CardAction>
        </CardHeader>
        <Dialog open={providerKeyOpen} onOpenChange={(open) => { setProviderKeyOpen(open); if (!open) setEditingProviderApiKey(null) }}>
          <DialogContent>
            <ProviderApiKeyForm key={editingProviderApiKey?.id || "new"} providers={[provider]} apiKey={editingProviderApiKey} onSave={saveProviderApiKey} />
          </DialogContent>
        </Dialog>
        {provider.prefix === "codex" && <Dialog open={Boolean(device)} onOpenChange={(open) => { if (!open) cancelCodexLogin() }}><DialogContent><DialogHeader><DialogTitle>Connect Codex account</DialogTitle><DialogDescription>Sign in, then copy the localhost URL from the browser address bar and paste it below. The localhost page may fail to load; that is expected.</DialogDescription></DialogHeader>{device && <div className="grid gap-4 py-2"><label htmlFor="codex-account-name" className="text-sm font-medium">Account label (optional)</label><Input id="codex-account-name" value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="Work Codex" maxLength={80} /><div className="rounded-lg border bg-muted/20 p-4 text-center"><Button nativeButton={false} size="sm" variant="outline" render={<a href={device.authorizationUrl} target="_blank" rel="noreferrer" />}><LinkIcon />Open Codex sign-in</Button></div><div className="grid gap-2"><label htmlFor="codex-callback-url" className="text-sm font-medium">Redirect URL</label><div className="flex gap-2"><Input id="codex-callback-url" value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder="http://localhost:1455/auth/callback?code=...&state=..." /><Button aria-busy={submittingCallback} disabled={!callbackUrl.trim() || submittingCallback} onClick={() => void submitCodexCallback()}>{submittingCallback && <LoadingSpinner />}Submit</Button></div><p className="text-xs text-muted-foreground">{polling ? "Waiting for the pasted callback..." : "Login paused."}</p></div></div>}<DialogFooter><Button variant="outline" onClick={cancelCodexLogin}>Cancel</Button></DialogFooter></DialogContent></Dialog>}
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20" />
                <TableHead>Name</TableHead>
                <TableHead>{isOAuthProvider ? "Plan" : "Limits"}</TableHead>
                <TableHead>Status</TableHead>
                {isOAuthProvider && <TableHead>Usage Limits</TableHead>}
                {isOAuthProvider && <TableHead>Unused Resets</TableHead>}
                <TableHead>Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiKeys.map((apiKey, index) => {
                const pendingKey = `delete-provider-api-key:${apiKey.id}`
                const moveUpPending = isPending(`move-provider-api-key:${apiKey.id}:-1`)
                const moveDownPending = isPending(`move-provider-api-key:${apiKey.id}:1`)
                const showQuota = isOAuthProvider && apiKey.credentialKind === "codex-cli-proxy"
                const accountUsage = usageData?.accounts[apiKey.id]
                const rowError = apiKey.cliProxyStatusMessage && ["missing", "error", "expired", "unavailable"].includes(apiKey.cliProxyStatus || "") ? apiKey.cliProxyStatusMessage : showQuota ? codexUsageError(accountUsage, usageError?.message) : undefined
                const orderCell = <TableCell className="align-middle"><div className="flex items-center gap-0.5"><Button aria-label={`Move ${apiKey.name} up`} aria-busy={moveUpPending} title="Move up" size="icon-xs" variant="ghost" disabled={index === 0 || moveUpPending || moveDownPending} onClick={() => void moveProviderApiKey(index, -1)}>{moveUpPending ? <LoadingSpinner /> : <ChevronUpIcon />}</Button><Button aria-label={`Move ${apiKey.name} down`} aria-busy={moveDownPending} title="Move down" size="icon-xs" variant="ghost" disabled={index === apiKeys.length - 1 || moveUpPending || moveDownPending} onClick={() => void moveProviderApiKey(index, 1)}>{moveDownPending ? <LoadingSpinner /> : <ChevronDownIcon />}</Button></div></TableCell>
                const codexActionCell = <TableCell className="align-middle px-0"><div className="flex items-center justify-end gap-1"><Button aria-label={`${apiKey.enabled ? "Disable" : "Enable"} ${apiKey.name}`} aria-busy={isPending(`toggle-codex-account:${apiKey.id}`)} size="icon-sm" variant="outline" disabled={apiKey.credentialKind !== "codex-cli-proxy" || isPending(`toggle-codex-account:${apiKey.id}`)} onClick={() => setToggleAccount(apiKey)}><PowerIcon /></Button><ConfirmAction title={`Remove ${apiKey.name}?`} description={apiKey.credentialKind === "codex-cli-proxy" ? "This deletes the CLIProxy OAuth credential. You can connect this account again later." : "This removes the unmatched legacy credential. Reconnect it to use this account again."} pending={isPending(`delete-codex-account:${apiKey.id}`)} onConfirm={() => deleteCodexAccount(apiKey)}><Trash2Icon /></ConfirmAction></div></TableCell>
                if (provider.prefix === "codex" && rowError) return <TableRow key={apiKey.id} className="bg-destructive/5">{orderCell}<TableCell colSpan={6} className="whitespace-normal px-4 py-4"><div className="flex min-w-0 flex-col gap-1"><span className="font-medium text-destructive">{apiKey.name}</span><span className="break-words text-sm text-destructive">{rowError}</span></div></TableCell>{codexActionCell}</TableRow>
                return <TableRow key={apiKey.id} className={apiKey.enabled ? undefined : "opacity-60"}>
                    {orderCell}
                    <TableCell className="font-medium">{apiKey.name}</TableCell>
                    <TableCell>{isOAuthProvider ? <Badge variant="secondary">{apiKey.planType ? apiKey.planType.charAt(0).toUpperCase() + apiKey.planType.slice(1) : "Codex"}</Badge> : <span className="text-sm text-muted-foreground">{apiKey.rpmLimit ? `${apiKey.rpmLimit} rpm` : "—"}<span className="mx-2 text-border">·</span>{apiKey.maxConcurrency ? `${apiKey.maxConcurrency} concurrent` : "—"}</span>}</TableCell>
                    <TableCell><Badge variant={apiKey.enabled ? "secondary" : "outline"} title={apiKey.cliProxyStatusMessage}>{apiKey.cliProxyStatus === "missing" ? "Reconnect required" : apiKey.enabled ? "Enabled" : "Disabled"}</Badge></TableCell>
                    {isOAuthProvider && (showQuota ? <CodexQuotaTableCell accountUsage={accountUsage} loading={usageLoading && !usageData} error={usageError?.message} /> : <TableCell className="text-muted-foreground">N/A</TableCell>)}
                    {isOAuthProvider && <TableCell className="align-middle">{(accountUsage?.unusedResetCredits ?? 0) > 0 ? <div className="flex items-center gap-2"><span className="tabular-nums">{accountUsage?.unusedResetCredits}</span>{apiKey.credentialKind === "codex-cli-proxy" && <Button aria-busy={isPending(`reset:${apiKey.id}`)} size="sm" variant="outline" disabled={accountUsage?.weekly?.remainingPercent !== 0 || isPending(`reset:${apiKey.id}`)} title="Requires an exhausted weekly quota" onClick={() => setResetAccount(apiKey)}>{isPending(`reset:${apiKey.id}`) ? <LoadingSpinner /> : <RotateCcwIcon />}Redeem</Button>}</div> : <span className="text-muted-foreground">Not Available</span>}</TableCell>}
                    <TableCell className="align-middle text-xs text-muted-foreground">{formatAppDate(apiKey.createdAt)}</TableCell>
                    {provider.prefix === "codex" ? codexActionCell : <TableCell className="align-middle px-0"><div className="flex items-center justify-end gap-1"><Button aria-label={`Edit ${apiKey.name}`} size="icon-sm" variant="ghost" onClick={() => { setEditingProviderApiKey(apiKey); setProviderKeyOpen(true) }}><PencilIcon /></Button><ConfirmAction title={`Delete ${apiKey.name}?`} description="Requests currently routed through this key will fail." pending={isPending(pendingKey)} onConfirm={() => deleteProviderApiKey(apiKey)}><Trash2Icon /></ConfirmAction></div></TableCell>}
                  </TableRow>
              })}
              {!apiKeys.length && <EmptyRow label={provider.authType === "none" ? "This provider does not require API keys." : isOAuthProvider ? "No accounts yet." : "No API keys yet."} colSpan={isOAuthProvider ? 8 : 6} />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <AlertDialog open={Boolean(resetAccount)} onOpenChange={(open) => { if (!open) { setResetAccount(null); setResetConfirmation("") } }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Redeem Codex reset credit?</AlertDialogTitle><AlertDialogDescription>This consumes one banked reset credit for {resetAccount?.name}. Type <code>use my codex reset</code> to confirm.</AlertDialogDescription></AlertDialogHeader>
          <Input value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} placeholder="use my codex reset" autoFocus />
          <AlertDialogFooter><AlertDialogCancel disabled={isPending(`reset:${resetAccount?.id}`)}>Cancel</AlertDialogCancel><AlertDialogAction aria-busy={isPending(`reset:${resetAccount?.id}`)} disabled={!resetConfirmation.toLowerCase().includes("use my codex reset") || isPending(`reset:${resetAccount?.id}`)} onClick={() => { if (resetAccount) void redeemReset(resetAccount) }}>{isPending(`reset:${resetAccount?.id}`) && <LoadingSpinner />}Redeem reset</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={Boolean(toggleAccount)} onOpenChange={(open) => { if (!open && !isPending(`toggle-codex-account:${toggleAccount?.id}`)) setToggleAccount(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{toggleAccount?.enabled ? "Disable" : "Enable"} Codex account?</AlertDialogTitle><AlertDialogDescription>{toggleAccount?.enabled ? `Requests will stop using ${toggleAccount.name} until you enable it again.` : `${toggleAccount?.name} will become available for fill-first routing.`}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={isPending(`toggle-codex-account:${toggleAccount?.id}`)}>Cancel</AlertDialogCancel><AlertDialogAction aria-busy={isPending(`toggle-codex-account:${toggleAccount?.id}`)} disabled={isPending(`toggle-codex-account:${toggleAccount?.id}`)} onClick={async () => { if (toggleAccount && await setCodexAccountEnabled(toggleAccount)) setToggleAccount(null) }}>{isPending(`toggle-codex-account:${toggleAccount?.id}`) && <LoadingSpinner />}{toggleAccount?.enabled ? "Disable account" : "Enable account"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BoxesIcon className="size-5" />Models</CardTitle>
          <CardDescription>{provider.prefix === "codex" ? "Built-in Codex models are fixed; custom Codex mappings can be added below." : "Expose upstream models behind your provider prefix."}</CardDescription>
          <CardAction><Button onClick={() => { setEditingModel(null); setModelOpen(true) }}><PlusIcon />Add model</Button></CardAction>
        </CardHeader>
        <Dialog open={modelOpen} onOpenChange={(open) => { setModelOpen(open); if (!open) setEditingModel(null) }}>
          <DialogContent>
            <ModelForm key={editingModel?.id || "new"} provider={provider} model={editingModel} onSave={saveModel} />
          </DialogContent>
        </Dialog>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Gateway ID</TableHead>
                <TableHead>Upstream model</TableHead>
                <TableHead>Provider protocol</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((model) => {
                const pendingKey = `delete-model:${model.id}`
                const gatewayModelId = model.gatewayModelId || model.id
                const builtin = model.source === "builtin"
                return <TableRow key={model.id} className={model.enabled ? undefined : "opacity-60"}>
                  <TableCell className="font-medium">{model.name}</TableCell>
                  <TableCell><div className="flex items-center justify-between gap-2"><div className="min-w-0 font-mono text-xs font-medium"><span className="break-all">{gatewayModelId}</span></div><Button aria-label={`Copy gateway ID ${gatewayModelId}`} size="icon-sm" variant="outline" className="shrink-0" onClick={() => { void navigator.clipboard.writeText(gatewayModelId); toast.success("Gateway ID copied") }}><CopyIcon /></Button></div></TableCell>
                  <TableCell>{model.upstreamModel}</TableCell>
                  <TableCell>{protocolLabels[provider.protocol]}</TableCell>
                  <TableCell><div className="flex items-center gap-2"><Badge variant={builtin ? "secondary" : "outline"}>{builtin ? "Built-in" : "Custom"}</Badge><Badge variant={model.enabled ? "secondary" : "outline"}>{model.enabled ? "Enabled" : "Disabled"}</Badge></div></TableCell>
                  <TableCell><div className="flex justify-end gap-1"><ModelShareButton modelId={model.id} modelName={model.name} disabled={!model.enabled || !provider.enabled} onSaved={mutate} />{builtin ? null : <><Button aria-label={`Edit ${model.name}`} size="icon-sm" variant="ghost" onClick={() => { setEditingModel(model); setModelOpen(true) }}><PencilIcon /></Button><ConfirmAction title={`Delete ${model.name}?`} description={`This permanently removes the ${model.name} mapping.`} pending={isPending(pendingKey)} onConfirm={() => deleteModel(model)}><Trash2Icon /></ConfirmAction></>}</div></TableCell>
                </TableRow>
              })}
              {!models.length && <EmptyRow label="No models yet." colSpan={6} />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  </main>
}
