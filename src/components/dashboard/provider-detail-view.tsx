import { useDashboardClipboard } from "@/hooks/use-dashboard-clipboard"
import { useCodexLogin } from "@/hooks/use-codex-login"
import { CodexLoginDialog } from "@/components/dashboard/codex-login-dialog"
import { useCallback, useState } from "react"
import { ArrowLeftIcon, BoxesIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, KeyRoundIcon, LogInIcon, PencilIcon, PlusIcon, PowerIcon, RotateCcwIcon, Trash2Icon } from "lucide-react"
import { Link, useNavigate } from "react-router"
import useSWR, { useSWRConfig, type KeyedMutator } from "swr"
import { toast } from "sonner"

import { ConfirmAction, DetailValue, EmptyRow, NotFoundState } from "@/components/dashboard/shared"
import { useDashboardApi } from "@/components/dashboard/api-context"
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
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { TableColumns, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { protocolLabels, type Model, type Provider, type ProviderApiKey } from "@/lib/types"
import { formatAppDate } from "@/lib/timezone"
import type { CodexDiscoveryStatus } from "@/lib/codex/model-discovery"

type ProviderDetailResponse = { provider: Provider; apiKeys: ProviderApiKey[]; models: Model[]; discovery?: CodexDiscoveryStatus }
const providerKey = (providerId: string) => `/api/admin/providers/${encodeURIComponent(providerId)}`

function ProviderDetailContent({ providerId, data, mutate }: { providerId: string; data: ProviderDetailResponse; mutate: KeyedMutator<ProviderDetailResponse> }) {
  const { fetcher, apiPost, apiDelete, apiPatch } = useDashboardApi()
  const { mutate: refreshCachedResource } = useSWRConfig()

  const usageKey = (data.provider.prefix === "codex" || data.apiKeys.some((apiKey) => apiKey.credentialKind === "codex-cli-proxy"))
    ? "/api/admin/oauth-providers/usage"
    : null
  const { data: usageData, error: usageError, isLoading: usageLoading } = useSWR<UsageResponse>(usageKey, fetcher, {
    refreshInterval: 300000,
    dedupingInterval: 300000,
    revalidateOnFocus: false,
  })

  const [providerKeyOpen, setProviderKeyOpen] = useState(false)

  const [editingProviderApiKey, setEditingProviderApiKey] = useState<ProviderApiKey | null>(null)

  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const [resetAccount, setResetAccount] = useState<ProviderApiKey | null>(null)
  const [resetConfirmation, setResetConfirmation] = useState("")
  const [toggleAccount, setToggleAccount] = useState<ProviderApiKey | null>(null)

  const onConnected = useCallback(() => Promise.all([mutate(), refreshCachedResource("/api/admin/providers")]), [mutate, refreshCachedResource])
  const login = useCodexLogin(onConnected)

  const isPending = (key: string) => pending.has(key)

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

  const { provider, apiKeys } = data
  const isOAuthProvider = provider.prefix === "codex" || (apiKeys.length > 0 && apiKeys.every((apiKey) => apiKey.credentialKind === "codex-cli-proxy"))

  return <main className="flex-1 bg-workspace p-4 dark:bg-background md:p-6 lg:p-8">
    <div className="mx-auto flex max-w-7xl flex-col gap-8">
      <ProviderHeading provider={provider} credentialCount={apiKeys.length} isOAuthProvider={isOAuthProvider} />
      <ProviderDetailsCard data={data} isOAuthProvider={isOAuthProvider} mutate={mutate} />
      <Card>
        <ProviderCredentialsHeader provider={provider} isOAuthProvider={isOAuthProvider} login={login} onAdd={() => { setEditingProviderApiKey(null); setProviderKeyOpen(true) }} />
        <Dialog open={providerKeyOpen} onOpenChange={(open) => { setProviderKeyOpen(open); if (!open) setEditingProviderApiKey(null) }}>
          <DialogContent>
            <ProviderApiKeyForm key={editingProviderApiKey?.id || "new"} providers={[provider]} apiKey={editingProviderApiKey} onSave={saveProviderApiKey} />
          </DialogContent>
        </Dialog>
        {provider.prefix === "codex" && <CodexLoginDialog login={login} />}
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
              {apiKeys.map((apiKey, index) => <ProviderKeyRow key={apiKey.id} apiKey={apiKey} index={index} provider={provider} isOAuthProvider={isOAuthProvider} usageData={usageData} usageError={usageError} usageLoading={usageLoading} isPending={isPending} moveProviderApiKey={moveProviderApiKey} setToggleAccount={setToggleAccount} deleteCodexAccount={deleteCodexAccount} setResetAccount={setResetAccount} deleteProviderApiKey={deleteProviderApiKey} apiKeyCount={apiKeys.length} editApiKey={(account) => { setEditingProviderApiKey(account); setProviderKeyOpen(true) }} />)}
              {!apiKeys.length && <EmptyRow label={provider.authType === "none" ? "This provider does not require API keys." : isOAuthProvider ? "No accounts yet." : "No API keys yet."} colSpan={isOAuthProvider ? 8 : 6} />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <CodexResetDialog resetAccount={resetAccount} setResetAccount={setResetAccount} resetConfirmation={resetConfirmation} setResetConfirmation={setResetConfirmation} isPending={isPending} redeemReset={redeemReset} />
      <CodexToggleDialog toggleAccount={toggleAccount} setToggleAccount={setToggleAccount} isPending={isPending} setCodexAccountEnabled={setCodexAccountEnabled} />
      <ProviderModelsCard data={data} mutate={mutate} />
    </div>
  </main>
}

function ProviderHeading({ provider, credentialCount, isOAuthProvider }: { provider: Provider; credentialCount: number; isOAuthProvider: boolean }) {
  const credentialLabel = isOAuthProvider
    ? (credentialCount === 1 ? "account" : "accounts")
    : `API ${credentialCount === 1 ? "key" : "keys"}`

  return <div>
    <Button nativeButton={false} variant="ghost" className="-ml-3 mb-3" render={<Link to="/dashboard/providers" />}><ArrowLeftIcon />Providers</Button>
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">{provider.name}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{credentialCount} {credentialLabel} configured</p>
    </div>
  </div>
}

function ProviderModelsCard({ data, mutate }: { data: ProviderDetailResponse; mutate: KeyedMutator<ProviderDetailResponse> }) {
  const copy = useDashboardClipboard()
  const { apiPost, apiDelete } = useDashboardApi()
  const { provider, models } = data
  const { mutate: refreshCachedResource } = useSWRConfig()
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const isPending = (key: string) => pending.has(key)
  const [refreshingModels, setRefreshingModels] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<Model | null>(null)
  async function refreshModels() {
    setRefreshingModels(true)
    try {
      const result = await apiPost<CodexDiscoveryStatus>(`${providerKey(data.provider.id)}/models/refresh`, {})
      await mutate()
      await refreshCachedResource("/api/admin/providers")
      if (result.error) toast.error(result.error)
      else toast.success(`Models refreshed: ${result.added} added${result.skipped ? `, ${result.skipped} custom mappings preserved` : ""}`)
    } catch (error) { toast.error(error instanceof Error ? error.message : "Model refresh failed") }
    finally { setRefreshingModels(false) }
  }
  async function toggleDiscoveredModel(model: Model) {
    try {
      await apiPost(`${providerKey(data.provider.id)}/models`, { model: { originalId: model.id, enabled: !model.enabled } })
      await mutate()
    } catch (error) { toast.error(error instanceof Error ? error.message : "Model update failed") }
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
  return <Card>
        <CardHeader>
          <CardTitle variant="icon"><BoxesIcon className="size-5" />Models</CardTitle>
          <CardDescription>{provider.prefix === "codex" ? <>Models are discovered from connected CLIProxy accounts. Custom mappings are preserved. {data.discovery?.succeededAt ? `Last synced: ${formatAppDate(data.discovery.succeededAt)}.` : "Waiting for first sync."}{data.discovery?.error && <span className="block text-destructive">{data.discovery.error}</span>}</> : "Expose upstream models behind your provider prefix."}</CardDescription>
          <CardAction><div className="flex gap-2">{provider.prefix === "codex" && <Button variant="outline" disabled={refreshingModels} onClick={() => void refreshModels()}>{refreshingModels ? <LoadingSpinner /> : <RotateCcwIcon />}Refresh models</Button>}<Button onClick={() => { setEditingModel(null); setModelOpen(true) }}><PlusIcon />Add model</Button></div></CardAction>
        </CardHeader>
        <Dialog open={modelOpen} onOpenChange={(open) => { setModelOpen(open); if (!open) setEditingModel(null) }}>
          <DialogContent>
            <ModelForm key={editingModel?.id || "new"} provider={provider} model={editingModel} onSave={saveModel} />
          </DialogContent>
        </Dialog>
        <CardContent>
          <Table>
            <TableColumns columns={[{ id: "Model", label: "Model" }, { id: "Gateway ID", label: "Gateway ID" }, { id: "Upstream model", label: "Upstream model" }, { id: "Provider protocol", label: "Provider protocol" }, { id: "Status", label: "Status" }, { id: "actions" }]} />
            <TableBody>
              {models.map((model) => {
                const pendingKey = `delete-model:${model.id}`
                const gatewayModelId = model.gatewayModelId || model.id
                const builtin = model.source === "builtin" || model.source === "discovered"
                return <TableRow key={model.id} variant={model.enabled ? "default" : "disabled"}>
                  <TableCell text="label">{model.name}</TableCell>
                  <TableCell><div className="flex items-center justify-between gap-2"><div className="min-w-0 font-mono text-xs font-medium"><span className="break-all">{gatewayModelId}</span></div><Button aria-label={`Copy gateway ID ${gatewayModelId}`} size="icon-sm" variant="outline" className="shrink-0" onClick={() => { void copy(gatewayModelId, "Gateway ID copied") }}><CopyIcon /></Button></div></TableCell>
                  <TableCell>{model.upstreamModel}</TableCell>
                  <TableCell>{protocolLabels[provider.protocol]}</TableCell>
                  <TableCell><div className="flex items-center gap-2"><Badge variant={builtin ? "secondary" : "outline"}>{model.source === "discovered" ? "Auto-discovered" : builtin ? "Legacy" : "Custom"}</Badge><Badge variant={model.enabled ? "secondary" : "outline"}>{model.enabled ? "Enabled" : "Disabled"}</Badge>{(model.discovery?.stale || model.source === "builtin") && <Badge variant="outline">Not recently observed</Badge>}{model.source === "discovered" && <Button size="icon-sm" variant="ghost" aria-label={`${model.enabled ? "Disable" : "Enable"} ${model.name}`} onClick={() => void toggleDiscoveredModel(model)}><PowerIcon /></Button>}</div></TableCell>
                  <TableCell><div className="flex justify-end gap-1"><ModelShareButton modelId={model.id} modelName={model.name} disabled={!model.enabled || !provider.enabled} onSaved={mutate} />{builtin ? null : <><Button aria-label={`Edit ${model.name}`} size="icon-sm" variant="ghost" onClick={() => { setEditingModel(model); setModelOpen(true) }}><PencilIcon /></Button><ConfirmAction title={`Delete ${model.name}?`} description={`This permanently removes the ${model.name} mapping.`} pending={isPending(pendingKey)} onConfirm={() => deleteModel(model)}><Trash2Icon /></ConfirmAction></>}</div></TableCell>
                </TableRow>
              })}
              {!models.length && <EmptyRow label="No models yet." colSpan={6} />}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
}

type ProviderKeyRowProps = {
  apiKey: ProviderApiKey
  index: number
  apiKeyCount: number
  provider: Provider
  isOAuthProvider: boolean
  usageData: UsageResponse | undefined
  usageError: Error | undefined
  usageLoading: boolean
  isPending: (key: string) => boolean
  moveProviderApiKey: (index: number, direction: -1 | 1) => Promise<void>
  setToggleAccount: (account: ProviderApiKey) => void
  deleteCodexAccount: (account: ProviderApiKey) => Promise<boolean>
  setResetAccount: (account: ProviderApiKey) => void
  editApiKey: (account: ProviderApiKey) => void
  deleteProviderApiKey: (account: ProviderApiKey) => Promise<boolean>
}

function ProviderKeyRow({ apiKey, index, apiKeyCount, provider, isOAuthProvider, usageData, usageError, usageLoading, isPending, moveProviderApiKey, setToggleAccount, deleteCodexAccount, setResetAccount, editApiKey, deleteProviderApiKey }: ProviderKeyRowProps) {
  const pendingKey = `delete-provider-api-key:${apiKey.id}`

  const showQuota = isOAuthProvider && apiKey.credentialKind === "codex-cli-proxy"
  const accountUsage = usageData?.accounts[apiKey.id]
  const rowError = apiKey.cliProxyStatusMessage && ["missing", "error", "expired", "unavailable"].includes(apiKey.cliProxyStatus || "") ? apiKey.cliProxyStatusMessage : showQuota ? codexUsageError(accountUsage, usageError?.message) : undefined
  const orderCell = <AccountOrderCell apiKey={apiKey} index={index} apiKeyCount={apiKeyCount} isPending={isPending} moveProviderApiKey={moveProviderApiKey} />
  const codexActionCell = <CodexAccountActions apiKey={apiKey} isPending={isPending} setToggleAccount={setToggleAccount} deleteCodexAccount={deleteCodexAccount} />
  if (provider.prefix === "codex" && rowError) return <TableRow key={apiKey.id} variant="error">{orderCell}<TableCell colSpan={6} density="comfortable"
            className="whitespace-normal"><div className="flex min-w-0 flex-col gap-1"><span className="font-medium text-destructive">{apiKey.name}</span><span className="break-words text-sm text-destructive">{rowError}</span></div></TableCell>{codexActionCell}</TableRow>
  return <TableRow key={apiKey.id} variant={apiKey.enabled ? "default" : "disabled"}>
      {orderCell}
      <TableCell text="label">{apiKey.name}</TableCell>
      <ProviderKeyMetadata apiKey={apiKey} isOAuthProvider={isOAuthProvider} />
      {isOAuthProvider && (showQuota ? <CodexQuotaTableCell accountUsage={accountUsage} loading={usageLoading && !usageData} error={usageError?.message} routingStatus={apiKey.cliProxyStatusMessage} /> : <TableCell tone="muted">N/A</TableCell>)}
      {isOAuthProvider && <AccountResetCell apiKey={apiKey} usageData={usageData} isPending={isPending} setResetAccount={setResetAccount} />}
      <TableCell text="small" tone="muted" className="align-middle">{formatAppDate(apiKey.createdAt)}</TableCell>
      {provider.prefix === "codex" ? codexActionCell : <TableCell density="flush" className="align-middle"><div className="flex items-center justify-end gap-1"><Button aria-label={`Edit ${apiKey.name}`} size="icon-sm" variant="ghost" onClick={() => editApiKey(apiKey)}><PencilIcon /></Button><ConfirmAction title={`Delete ${apiKey.name}?`} description="Requests currently routed through this key will fail." pending={isPending(pendingKey)} onConfirm={() => deleteProviderApiKey(apiKey)}><Trash2Icon /></ConfirmAction></div></TableCell>}
    </TableRow>
}

function CodexResetDialog({ resetAccount, setResetAccount, resetConfirmation, setResetConfirmation, isPending, redeemReset }: {
  resetAccount: ProviderApiKey | null
  setResetAccount: (account: ProviderApiKey | null) => void
  resetConfirmation: string
  setResetConfirmation: (value: string) => void
  isPending: (key: string) => boolean
  redeemReset: (account: ProviderApiKey) => Promise<void>
}) {
  return <AlertDialog open={Boolean(resetAccount)} onOpenChange={(open) => { if (!open) { setResetAccount(null); setResetConfirmation("") } }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Redeem Codex reset credit?</AlertDialogTitle><AlertDialogDescription>This consumes one banked reset credit for {resetAccount?.name}. Type <code>use my codex reset</code> to confirm.</AlertDialogDescription></AlertDialogHeader>
          <Input value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} placeholder="use my codex reset" autoFocus />
          <AlertDialogFooter><AlertDialogCancel disabled={isPending(`reset:${resetAccount?.id}`)}>Cancel</AlertDialogCancel><AlertDialogAction aria-busy={isPending(`reset:${resetAccount?.id}`)} disabled={!resetConfirmation.toLowerCase().includes("use my codex reset") || isPending(`reset:${resetAccount?.id}`)} onClick={() => { if (resetAccount) void redeemReset(resetAccount) }}>{isPending(`reset:${resetAccount?.id}`) && <LoadingSpinner />}Redeem reset</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
}

function CodexToggleDialog({ toggleAccount, setToggleAccount, isPending, setCodexAccountEnabled }: {
  toggleAccount: ProviderApiKey | null
  setToggleAccount: (account: ProviderApiKey | null) => void
  isPending: (key: string) => boolean
  setCodexAccountEnabled: (account: ProviderApiKey) => Promise<boolean>
}) {
  return <AlertDialog open={Boolean(toggleAccount)} onOpenChange={(open) => { if (!open && !isPending(`toggle-codex-account:${toggleAccount?.id}`)) setToggleAccount(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{toggleAccount?.enabled ? "Disable" : "Enable"} Codex account?</AlertDialogTitle><AlertDialogDescription>{toggleAccount?.enabled ? `Requests will stop using ${toggleAccount.name} until you enable it again.` : `${toggleAccount?.name} will become available for fill-first routing.`}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={isPending(`toggle-codex-account:${toggleAccount?.id}`)}>Cancel</AlertDialogCancel><AlertDialogAction aria-busy={isPending(`toggle-codex-account:${toggleAccount?.id}`)} disabled={isPending(`toggle-codex-account:${toggleAccount?.id}`)} onClick={async () => { if (toggleAccount && await setCodexAccountEnabled(toggleAccount)) setToggleAccount(null) }}>{isPending(`toggle-codex-account:${toggleAccount?.id}`) && <LoadingSpinner />}{toggleAccount?.enabled ? "Disable account" : "Enable account"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
}

function AccountOrderCell({ apiKey, index, apiKeyCount, isPending, moveProviderApiKey }: Pick<ProviderKeyRowProps, "apiKey" | "index" | "apiKeyCount" | "isPending" | "moveProviderApiKey">) {
  const moveUpPending = isPending(`move-provider-api-key:${apiKey.id}:-1`)
  const moveDownPending = isPending(`move-provider-api-key:${apiKey.id}:1`)
  return <TableCell className="align-middle"><div className="flex items-center gap-0.5"><Button aria-label={`Move ${apiKey.name} up`} aria-busy={moveUpPending} title="Move up" size="icon-xs" variant="ghost" disabled={index === 0 || moveUpPending || moveDownPending} onClick={() => void moveProviderApiKey(index, -1)}>{moveUpPending ? <LoadingSpinner /> : <ChevronUpIcon />}</Button><Button aria-label={`Move ${apiKey.name} down`} aria-busy={moveDownPending} title="Move down" size="icon-xs" variant="ghost" disabled={index === apiKeyCount - 1 || moveUpPending || moveDownPending} onClick={() => void moveProviderApiKey(index, 1)}>{moveDownPending ? <LoadingSpinner /> : <ChevronDownIcon />}</Button></div></TableCell>
}

function CodexAccountActions({ apiKey, isPending, setToggleAccount, deleteCodexAccount }: Pick<ProviderKeyRowProps, "apiKey" | "isPending" | "setToggleAccount" | "deleteCodexAccount">) {
  return <TableCell density="flush" className="align-middle"><div className="flex items-center justify-end gap-1"><Button aria-label={`${apiKey.enabled ? "Disable" : "Enable"} ${apiKey.name}`} aria-busy={isPending(`toggle-codex-account:${apiKey.id}`)} size="icon-sm" variant="outline" disabled={apiKey.credentialKind !== "codex-cli-proxy" || isPending(`toggle-codex-account:${apiKey.id}`)} onClick={() => setToggleAccount(apiKey)}><PowerIcon /></Button><ConfirmAction title={`Remove ${apiKey.name}?`} description={apiKey.credentialKind === "codex-cli-proxy" ? "This deletes the CLIProxy OAuth credential. You can connect this account again later." : "This removes the unmatched legacy credential. Reconnect it to use this account again."} pending={isPending(`delete-codex-account:${apiKey.id}`)} onConfirm={() => deleteCodexAccount(apiKey)}><Trash2Icon /></ConfirmAction></div></TableCell>
}

function AccountResetCell({ apiKey, usageData, isPending, setResetAccount }: Pick<ProviderKeyRowProps, "apiKey" | "usageData" | "isPending" | "setResetAccount">) {
  const accountUsage = usageData?.accounts[apiKey.id]
  return <TableCell className="align-middle">{(accountUsage?.unusedResetCredits ?? 0) > 0 ? <div className="flex items-center gap-2"><span className="tabular-nums">{accountUsage?.unusedResetCredits}</span>{apiKey.credentialKind === "codex-cli-proxy" && <Button aria-busy={isPending(`reset:${apiKey.id}`)} size="sm" variant="outline" disabled={accountUsage?.weekly?.remainingPercent !== 0 || isPending(`reset:${apiKey.id}`)} title="Requires an exhausted weekly quota" onClick={() => setResetAccount(apiKey)}>{isPending(`reset:${apiKey.id}`) ? <LoadingSpinner /> : <RotateCcwIcon />}Redeem</Button>}</div> : <span className="text-muted-foreground">Not Available</span>}</TableCell>
}

function ProviderDetailsCard({ data, isOAuthProvider, mutate }: { data: ProviderDetailResponse; isOAuthProvider: boolean; mutate: KeyedMutator<ProviderDetailResponse> }) {
  const { apiPost, apiDelete } = useDashboardApi()
  const { provider, apiKeys, models } = data
  const apiKeyCounts = { configured: apiKeys.length }
  const navigate = useNavigate()
  const { mutate: refreshCachedResource } = useSWRConfig()
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const isPending = (key: string) => pending.has(key)
  const [providerOpen, setProviderOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
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
      navigate("/dashboard/providers")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }
  return <Card>
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
}

function ProviderCredentialsHeader({ provider, isOAuthProvider, login, onAdd }: { provider: Provider; isOAuthProvider: boolean; login: ReturnType<typeof useCodexLogin>; onAdd: () => void }) {
  const { device, starting, connect } = login
  return <CardHeader>
          <CardTitle variant="icon"><KeyRoundIcon className="size-5" />{isOAuthProvider ? "Accounts" : "API keys"}</CardTitle>
          <CardDescription>The account at the top has the highest priority. CLIProxy uses fill-first routing and only falls through when that account is unavailable.</CardDescription>
          <CardAction>{provider.prefix === "codex" ? <Button aria-busy={starting} onClick={() => void connect()} disabled={starting || Boolean(device)}>{starting ? <LoadingSpinner /> : <LogInIcon />}Add Codex Account</Button> : <Button disabled={provider.authType === "none"} onClick={onAdd}><PlusIcon />Add API key</Button>}</CardAction>
        </CardHeader>
}

function ProviderKeyMetadata({ apiKey, isOAuthProvider }: Pick<ProviderKeyRowProps, "apiKey" | "isOAuthProvider">) {
  return <><TableCell>{isOAuthProvider ? <Badge variant="secondary">{apiKey.planType ? apiKey.planType.charAt(0).toUpperCase() + apiKey.planType.slice(1) : "Codex"}</Badge> : <span className="text-sm text-muted-foreground">{apiKey.rpmLimit ? `${apiKey.rpmLimit} rpm` : "—"}<span className="mx-2 text-border">·</span>{apiKey.maxConcurrency ? `${apiKey.maxConcurrency} concurrent` : "—"}</span>}</TableCell>
                    <TableCell><Badge variant={apiKey.enabled ? "secondary" : "outline"} title={apiKey.cliProxyStatusMessage}>{apiKey.cliProxyStatus === "missing" ? "Reconnect required" : apiKey.enabled ? "Enabled" : "Disabled"}</Badge></TableCell></>
}

export function ProviderDetailView({ providerId }: { providerId: string }) {
  const { fetcher } = useDashboardApi()
  const { data, error, isLoading, mutate } = useSWR<ProviderDetailResponse>(providerKey(providerId), fetcher, { refreshInterval: providerId === "codex" ? 15000 : 0 })
  if (error) return <NotFoundState />
  if (isLoading || !data) return <DashboardContentSkeleton variant="provider-detail" />
  return <ProviderDetailContent providerId={providerId} data={data} mutate={mutate} />
}
