import { aiPagePaths as pagePaths } from "../../contracts/pages"
import { DashboardPage } from "@rawroute/ui/page-layout"
import { useDashboardClipboard } from "@rawroute/platform/web/use-dashboard-clipboard"
import { useCodexLogin } from "../use-codex-login"
import { CodexLoginDialog } from "./codex-login-dialog"
import { CodexResetCreditsInfo } from "./codex-reset-credits"
import { useCallback, useState } from "react"
import { ArrowLeftIcon, BoxesIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, InfoIcon, KeyRoundIcon, LogInIcon, PencilIcon, PlusIcon, PowerIcon, RotateCcwIcon, Trash2Icon } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@rawroute/ui/popover"
import { Link, useNavigate } from "react-router"
import useSWR, { useSWRConfig, type KeyedMutator } from "swr"
import { toast } from "sonner"

import { ConfirmAction, EmptyTableRow, NotFoundState } from "@rawroute/ui/resource-feedback"
import { useDashboardApi } from "@rawroute/platform/web/api-context"
import { withPendingAction } from "@rawroute/ui/pending-action"
import { codexUsageError, CodexPlanBadge, CodexQuotaTableCell, type UsageResponse } from "./codex-quota"
import { ModelForm } from "./model-form"
import { ModelShareButton } from "./model-share-button"
import { ProviderApiKeyForm } from "./provider-api-key-form"
import { ProviderForm } from "./provider-form"
import { Input } from "@rawroute/ui/input"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@rawroute/ui/alert-dialog"
import { AiContentSkeleton as DashboardContentSkeleton } from "../skeletons"
import { LoadingSpinner } from "@rawroute/ui/loading-spinner"
import { RefreshScrim } from "@rawroute/ui/loading-layout"
import { Badge } from "@rawroute/ui/badge"
import { Button } from "@rawroute/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { Dialog, DialogContent } from "@rawroute/ui/dialog"
import { TableColumns, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@rawroute/ui/table"
import { protocolLabels, type Model, type Provider, type ProviderApiKey, type ProviderApiKeyInput } from "../../contracts/domain"
import { formatAppDate } from "@rawroute/observability/contracts/timezone"
import type { CodexDiscoveryStatus } from "../../contracts/codex"
import type { CodexAutoRedeemResponse, CodexAutoRedeemSettings } from "../../contracts/codex"
import { modelUnavailable } from "../../contracts/catalog"
import { Checkbox } from "@rawroute/ui/checkbox"

type ProviderDetailResponse = { provider: Provider; apiKeys: ProviderApiKey[]; models: (Model & { removalBlockers?: string[] })[]; discovery?: CodexDiscoveryStatus }
const providerKey = (providerId: string) => `/api/admin/providers/${encodeURIComponent(providerId)}`
const providerUsageKey = (provider: Provider) => provider.prefix === "codex" ? "/api/admin/oauth-providers/usage" : null
const usesOAuthCredentials = (provider: Provider) => provider.prefix === "codex"

type ProviderDetailActionInput = {
  provider: Provider
  providerId: string
  apiKeys: ProviderApiKey[]
  apiPost: ReturnType<typeof useDashboardApi>["apiPost"]
  apiDelete: ReturnType<typeof useDashboardApi>["apiDelete"]
  apiPatch: ReturnType<typeof useDashboardApi>["apiPatch"]
  mutate: KeyedMutator<ProviderDetailResponse>
  refreshCachedResource: ReturnType<typeof useSWRConfig>["mutate"]
  pending: React.Dispatch<React.SetStateAction<Set<string>>>
  resetConfirmation: string
  setResetAccount: React.Dispatch<React.SetStateAction<ProviderApiKey | null>>
  setResetConfirmation: React.Dispatch<React.SetStateAction<string>>
  editingProviderApiKey: ProviderApiKey | null
  setProviderKeyOpen: React.Dispatch<React.SetStateAction<boolean>>
}

function createProviderDetailActions({ provider, providerId, apiKeys, apiPost, apiDelete, apiPatch, mutate, refreshCachedResource, pending, resetConfirmation, setResetAccount, setResetConfirmation, editingProviderApiKey, setProviderKeyOpen }: ProviderDetailActionInput) {
  return {
    redeemReset: (account: ProviderApiKey) => withPendingAction(`reset:${account.id}`, pending, async () => {
      await apiPost(`/api/admin/oauth-providers/${account.id}/reset`, { confirmation: resetConfirmation })
      await refreshCachedResource<UsageResponse>("/api/admin/oauth-providers/usage", current => current ? {
        accounts: { ...current.accounts, [account.id]: { ...current.accounts[account.id], fiveHour: null, weekly: null, fetchedAt: null, stale: false, refreshPending: true } },
      } : current)
      setResetAccount(null)
      setResetConfirmation("")
      toast.success("Codex reset credit redeemed")
    }, (error) => toast.error(error instanceof Error ? error.message : "Unable to redeem reset credit")),
    deleteCodexAccount: (account: ProviderApiKey) => withPendingAction(`delete-codex-account:${account.id}`, pending, async () => {
      await apiDelete(`/api/admin/oauth-providers/${account.id}`)
      await Promise.all([mutate(), refreshCachedResource("/api/admin/providers"), refreshCachedResource("/api/admin/oauth-providers/usage")])
      toast.success("Codex account removed")
      return true
    }, (error) => toast.error(error instanceof Error ? error.message : "Unable to remove Codex account")).then((result) => result ?? false),
    setCodexAccountEnabled: (account: ProviderApiKey) => withPendingAction(`toggle-codex-account:${account.id}`, pending, async () => {
      await apiPatch(`/api/admin/oauth-providers/${account.id}`, { enabled: !account.enabled })
      await Promise.all([mutate(), refreshCachedResource("/api/admin/providers"), refreshCachedResource("/api/admin/oauth-providers/usage")])
      toast.success(`Codex account ${account.enabled ? "disabled" : "enabled"}`)
      return true
    }, (error) => toast.error(error instanceof Error ? error.message : "Unable to update Codex account")).then((result) => result ?? false),
    setProviderApiKeyEnabled: (account: ProviderApiKey) => withPendingAction(`toggle-provider-api-key:${account.id}`, pending, async () => {
      await apiPost(`/api/admin/providers/${provider.id}/api-keys`, { providerApiKey: { originalId: account.id, name: account.name, key: "__unchanged__", enabled: !account.enabled } })
      await Promise.all([mutate(), refreshCachedResource("/api/admin/providers")])
      toast.success(`API key ${account.enabled ? "disabled" : "enabled"}`)
      return true
    }, (error) => toast.error(error instanceof Error ? error.message : "Unable to update API key")).then((result) => result ?? false),
    saveProviderApiKey: (apiKey: ProviderApiKeyInput) => withPendingAction("save-provider-api-key", pending, async () => {
      await apiPost(`/api/admin/providers/${provider.id}/api-keys`, { providerApiKey: apiKey })
      toast.success(editingProviderApiKey ? "Provider API key updated" : "Provider API key added")
      await mutate()
      await refreshCachedResource("/api/admin/providers")
      setProviderKeyOpen(false)
      return true
    }, (error) => toast.error(error instanceof Error ? error.message : "Request failed")).then((result) => result ?? false),
    deleteProviderApiKey: (apiKey: ProviderApiKey) => withPendingAction(`delete-provider-api-key:${apiKey.id}`, pending, async () => {
      await apiDelete(`/api/admin/providers/${providerId}/api-keys/${apiKey.id}`)
      toast.success("Provider API key deleted")
      await mutate()
      await refreshCachedResource("/api/admin/providers")
      return true
    }, (error) => toast.error(error instanceof Error ? error.message : "Request failed")).then((result) => result ?? false),
    moveProviderApiKey: (index: number, direction: -1 | 1) => {
      const nextIndex = index + direction
      if (nextIndex < 0 || nextIndex >= apiKeys.length) return Promise.resolve()
      const orderedIds = apiKeys.map((apiKey) => apiKey.id)
      ;[orderedIds[index], orderedIds[nextIndex]] = [orderedIds[nextIndex], orderedIds[index]]
      return withPendingAction(`move-provider-api-key:${apiKeys[index].id}:${direction}`, pending, async () => {
        await apiPost(`/api/admin/providers/${provider.id}/api-keys/reorder`, { orderedIds })
        await mutate()
      }, (error) => toast.error(error instanceof Error ? error.message : "Request failed")).then(() => undefined)
    },
  }
}

function ProviderDetailContent({ providerId, data, mutate, refreshing }: { providerId: string; data: ProviderDetailResponse; mutate: KeyedMutator<ProviderDetailResponse>; refreshing: boolean }) {
  const { fetcher, apiPost, apiDelete, apiPatch } = useDashboardApi()
  const { mutate: refreshCachedResource } = useSWRConfig()
  const usageKey = providerUsageKey(data.provider)
  const { data: usageData, error: usageError, isLoading: usageLoading } = useSWR<UsageResponse>(usageKey, fetcher, {
    refreshInterval: (usage) => Object.values(usage?.accounts || {}).some(account => account.refreshPending) ? 2000 : 300000,
    dedupingInterval: 1000,
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

  const { provider, apiKeys } = data
  const actions = createProviderDetailActions({ provider, providerId, apiKeys, apiPost, apiDelete, apiPatch, mutate, refreshCachedResource, pending: setPending, resetConfirmation, setResetAccount, setResetConfirmation, editingProviderApiKey, setProviderKeyOpen })
  const isOAuthProvider = usesOAuthCredentials(provider)

  return <DashboardPage>
      <ProviderHeading provider={provider} credentialCount={apiKeys.length} isOAuthProvider={isOAuthProvider} />
      <ProviderDetailsCard data={data} isOAuthProvider={isOAuthProvider} mutate={mutate} refreshing={refreshing} />
      {provider.prefix === "codex" && <CodexAutoRedeemCard accounts={apiKeys} />}
      <ProviderCredentialsCard provider={provider} apiKeys={apiKeys} isOAuthProvider={isOAuthProvider} usageData={usageData} usageError={usageError} usageLoading={usageLoading} isPending={isPending} actions={actions} login={login} providerKeyOpen={providerKeyOpen} setProviderKeyOpen={setProviderKeyOpen} editingProviderApiKey={editingProviderApiKey} setEditingProviderApiKey={setEditingProviderApiKey} setToggleAccount={setToggleAccount} setResetAccount={setResetAccount} refreshing={refreshing} />
      <CodexResetDialog resetAccount={resetAccount} setResetAccount={setResetAccount} resetConfirmation={resetConfirmation} setResetConfirmation={setResetConfirmation} isPending={isPending} redeemReset={actions.redeemReset} />
      <CredentialToggleDialog toggleAccount={toggleAccount} setToggleAccount={setToggleAccount} isPending={isPending} onToggle={(account) => account.credentialKind === "codex-oauth" ? actions.setCodexAccountEnabled(account) : actions.setProviderApiKeyEnabled(account)} />
      <ProviderModelsCard data={data} mutate={mutate} refreshing={refreshing} />
    </DashboardPage>
}

const codexAutoRedeemKey = "/api/admin/oauth-providers/auto-redeem/settings"

function CodexAutoRedeemCard({ accounts }: { accounts: ProviderApiKey[] }) {
  const { fetcher, apiPatch } = useDashboardApi()
  const { data, mutate } = useSWR<CodexAutoRedeemResponse>(codexAutoRedeemKey, fetcher, {
    refreshInterval: 60_000,
    dedupingInterval: 15_000,
  })
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  // Saving settings refetches under the overlay; the 60s status poll stays silent.
  const refreshSettings = () => { setRefreshing(true); return mutate().finally(() => setRefreshing(false)) }
  const [enableSetting, setEnableSetting] = useState<keyof CodexAutoRedeemSettings | null>(null)
  const settings = data?.settings || { expiryEnabled: true, weeklyExhaustionEnabled: false }
  const codexAccounts = accounts.filter(account => account.credentialKind === "codex-oauth")

  async function updateSetting(input: { expiryEnabled?: boolean; weeklyExhaustionEnabled?: boolean }) {
    setSaving(true)
    try {
      await apiPatch(codexAutoRedeemKey, input)
      await refreshSettings()
      toast.success("Codex reset automation settings saved")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save Codex reset settings")
      return false
    } finally {
      setSaving(false)
    }
  }

  function toggleSetting(setting: keyof CodexAutoRedeemSettings, checked: boolean) {
    if (checked) setEnableSetting(setting)
    else void updateSetting({ [setting]: false })
  }

  return <Card className="relative" aria-busy={refreshing || undefined}>
    {refreshing && <RefreshScrim />}
    <CardHeader>
      <CardTitle variant="icon"><RotateCcwIcon className="size-5" />Auto redeem</CardTitle>
      <CardDescription>Automatically use reset credits for your Codex accounts.</CardDescription>
    </CardHeader>
    <CardContent>
      <div className="@container space-y-4">
      <div className="grid gap-4 @xl:grid-cols-2">
      <label className="flex items-start gap-3 text-sm">
        <Checkbox aria-label="Redeem reset credits expiring within one hour" checked={settings.expiryEnabled} disabled={saving || !data} onCheckedChange={checked => toggleSetting("expiryEnabled", checked === true)} />
        <span className="grid gap-1"><span className="font-medium">Before credits expire</span><span className="text-muted-foreground">Redeem eligible credits within 1 hour of expiry.</span></span>
      </label>
      <label className="flex items-start gap-3 text-sm">
        <Checkbox aria-label="Also redeem when weekly quota is exhausted" checked={settings.weeklyExhaustionEnabled} disabled={saving || !data} onCheckedChange={checked => toggleSetting("weeklyExhaustionEnabled", checked === true)} />
        <span className="grid gap-1"><span className="font-medium">When weekly quota runs out</span><span className="text-muted-foreground">Use a reset credit when weekly remaining quota reaches 0%.</span></span>
      </label>
      </div>
      <div className="border-t pt-3">
        <h3 className="text-sm font-medium">Account status</h3>
        {!codexAccounts.length && <p className="text-sm text-muted-foreground">Connect a Codex account to get started.</p>}
        {codexAccounts.map(account => {
          const status = data?.accounts[account.id]
          const unknown = status?.phase === "unknown"
          const badge = unknown ? "Outcome unknown" : status?.phase === "redeemed" ? "Redeemed" : status?.phase === "checking" ? "Checking" : status?.phase === "pending" ? "Pending" : !account.enabled ? "Disabled" : "Waiting"
          return <div key={account.id} className="flex items-center justify-between gap-3 border-b py-2 text-sm last:border-b-0">
            <span className="min-w-0 break-all font-medium">{account.name}</span>
            <span className="flex shrink-0 items-center gap-1"><Badge variant={unknown ? "outline" : "secondary"}>{unknown ? "Retries paused" : badge}</Badge><RedeemStatusInfo status={badge} account={account.name} /></span>
          </div>
        })}
      </div>
      </div>
    </CardContent>
    <AlertDialog open={enableSetting !== null} onOpenChange={open => { if (!open && !saving) setEnableSetting(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{enableSetting === "expiryEnabled" ? "Enable expiring-credit auto-redeem?" : "Enable weekly-quota auto-redeem?"}</AlertDialogTitle>
          <AlertDialogDescription>{enableSetting === "expiryEnabled"
            ? "Uses a reset credit when weekly quota is exhausted. Credits expiring within 1 hour may be redeemed immediately."
            : "Uses a reset credit when weekly quota reaches 0%. If already exhausted, waits 1 minute. Turn off during that minute to cancel."}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={saving} onClick={async () => {
            if (enableSetting && await updateSetting({ [enableSetting]: true })) setEnableSetting(null)
          }}>{saving && <LoadingSpinner />}Enable auto-redeem</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Card>
}

const redeemStatusHints = {
  Waiting: "Waiting for a reset rule to apply.",
  Redeemed: "A reset credit was used successfully.",
  Checking: "Checking whether a reset credit can be used.",
  Pending: "Reset requested. Awaiting confirmation.",
  Disabled: "This account is excluded from automatic checks.",
  "Outcome unknown": "The last reset could not be confirmed.",
}

function RedeemStatusInfo({ status, account }: { status: keyof typeof redeemStatusHints; account: string }) {
  const [open, setOpen] = useState(false)
  const label = `${status} status for ${account}`
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger openOnHover render={<Button variant="ghost" size="icon-xs" aria-label={label} onFocus={event => {
      if (event.currentTarget.matches(":focus-visible")) setOpen(true)
    }}><InfoIcon /></Button>} />
    <PopoverContent aria-label={label} align="end" initialFocus={false} finalFocus={false} className="w-fit max-w-64">{redeemStatusHints[status]}</PopoverContent>
  </Popover>
}

function ProviderCredentialsCard({ provider, apiKeys, isOAuthProvider, usageData, usageError, usageLoading, isPending, actions, login, providerKeyOpen, setProviderKeyOpen, editingProviderApiKey, setEditingProviderApiKey, setToggleAccount, setResetAccount, refreshing }: {
  provider: Provider
  apiKeys: ProviderApiKey[]
  isOAuthProvider: boolean
  usageData: UsageResponse | undefined
  usageError: Error | undefined
  usageLoading: boolean
  isPending: (key: string) => boolean
  actions: ReturnType<typeof createProviderDetailActions>
  login: ReturnType<typeof useCodexLogin>
  providerKeyOpen: boolean
  setProviderKeyOpen: React.Dispatch<React.SetStateAction<boolean>>
  editingProviderApiKey: ProviderApiKey | null
  setEditingProviderApiKey: React.Dispatch<React.SetStateAction<ProviderApiKey | null>>
  setToggleAccount: (account: ProviderApiKey) => void
  setResetAccount: (account: ProviderApiKey) => void
  refreshing: boolean
}) {
  return <Card className="relative" aria-busy={refreshing || undefined}>
    {refreshing && <RefreshScrim />}
    <ProviderCredentialsHeader provider={provider} isOAuthProvider={isOAuthProvider} login={login} onAdd={() => { setEditingProviderApiKey(null); setProviderKeyOpen(true) }} />
    <Dialog open={providerKeyOpen} onOpenChange={(open) => { setProviderKeyOpen(open); if (!open) setEditingProviderApiKey(null) }}>
      <DialogContent>
        <ProviderApiKeyForm key={editingProviderApiKey?.id || "new"} providers={[provider]} apiKey={editingProviderApiKey} onSave={actions.saveProviderApiKey} />
      </DialogContent>
    </Dialog>
    {provider.prefix === "codex" && <CodexLoginDialog login={login} />}
    <CardContent>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20" />
            <TableHead>Name</TableHead>
            <TableHead>{isOAuthProvider ? "Plan" : "Local limits"}</TableHead>
            <TableHead>Status</TableHead>
            {isOAuthProvider && <TableHead>Usage Limits</TableHead>}
            {isOAuthProvider && <TableHead>Unused Resets</TableHead>}
            <TableHead>Created</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {apiKeys.map((apiKey, index) => <ProviderKeyRow key={apiKey.id} apiKey={apiKey} index={index} provider={provider} isOAuthProvider={isOAuthProvider} usageData={usageData} usageError={usageError} usageLoading={usageLoading} isPending={isPending} moveProviderApiKey={actions.moveProviderApiKey} setToggleAccount={setToggleAccount} deleteCodexAccount={actions.deleteCodexAccount} setResetAccount={setResetAccount} deleteProviderApiKey={actions.deleteProviderApiKey} apiKeyCount={apiKeys.length} editApiKey={(account) => { setEditingProviderApiKey(account); setProviderKeyOpen(true) }} />)}
          {!apiKeys.length && <EmptyTableRow title={provider.authType === "none" ? "No API keys required" : isOAuthProvider ? "No accounts yet" : "No API keys yet"} description={provider.authType === "none" ? "This provider does not require API keys." : isOAuthProvider ? "Connect an account to make this provider available for routing." : "Add an API key to route requests through this provider."} icon={KeyRoundIcon} colSpan={isOAuthProvider ? 8 : 6} />}
        </TableBody>
      </Table>
    </CardContent>
  </Card>
}

function ProviderHeading({ provider, credentialCount, isOAuthProvider }: { provider: Provider; credentialCount: number; isOAuthProvider: boolean }) {
  const credentialLabel = isOAuthProvider
    ? (credentialCount === 1 ? "account" : "accounts")
    : `API ${credentialCount === 1 ? "key" : "keys"}`

  return <div>
    <Button nativeButton={false} variant="ghost" className="-ml-3 mb-3" render={<Link to={pagePaths.providers} />}><ArrowLeftIcon />Providers</Button>
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">{provider.name}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{credentialCount} {credentialLabel} configured</p>
    </div>
  </div>
}

function ProviderModelsCard({ data, mutate, refreshing }: { data: ProviderDetailResponse; mutate: KeyedMutator<ProviderDetailResponse>; refreshing: boolean }) {
  const copy = useDashboardClipboard()
  const { apiPost, apiDelete } = useDashboardApi()
  const { provider, models } = data
  const showProtocol = provider.prefix !== "codex"
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
  return <Card className="relative" aria-busy={refreshing || undefined}>
        {refreshing && <RefreshScrim />}
        <CardHeader>
          <CardTitle variant="icon"><BoxesIcon className="size-5" />Models</CardTitle>
          <CardDescription>{provider.prefix === "codex" ? <>{data.discovery?.succeededAt ? `Last synced: ${formatAppDate(data.discovery.succeededAt)}.` : "Waiting for first sync."}{data.discovery?.error && <details className="text-destructive"><summary>Couldn’t refresh models. Try again.</summary>{data.discovery.error}</details>}</> : "Choose which models your apps can use."}</CardDescription>
          <CardAction><div className="flex gap-2">{provider.prefix === "codex" && <Button variant="outline" disabled={refreshingModels} onClick={() => void refreshModels()}>{refreshingModels ? <LoadingSpinner /> : <RotateCcwIcon />}Refresh models</Button>}<Button onClick={() => { setEditingModel(null); setModelOpen(true) }}><PlusIcon />Add model</Button></div></CardAction>
        </CardHeader>
        <Dialog open={modelOpen} onOpenChange={(open) => { setModelOpen(open); if (!open) setEditingModel(null) }}>
          <DialogContent>
            <ModelForm key={editingModel?.id || "new"} provider={provider} model={editingModel} onSave={saveModel} />
          </DialogContent>
        </Dialog>
        <CardContent>
          <Table>
            <TableColumns columns={[{ id: "Model", label: "Model" }, { id: "Gateway ID", label: "Gateway ID" }, { id: "Provider model ID", label: "Provider model ID" }, ...(showProtocol ? [{ id: "Provider protocol", label: "Provider protocol" }] : []), { id: "Status", label: "Status" }, { id: "actions" }]} />
            <TableBody>
              {models.map((model) => {
                const pendingKey = `delete-model:${model.id}`
                const gatewayModelId = model.gatewayModelId || model.id
                const discovered = model.source === "discovered"
                const unavailable = modelUnavailable(model)
                const status = unavailable ? "Unavailable" : !model.enabled || !provider.enabled ? "Disabled" : model.discovery?.stale ? "Not confirmed" : "Available"
                return <TableRow key={model.id} variant={model.enabled ? "default" : "disabled"}>
                  <TableCell text="label">{model.name}</TableCell>
                  <TableCell><div className="flex items-center justify-between gap-2"><div className="min-w-0 font-mono text-xs font-medium"><span className="break-all">{gatewayModelId}</span></div><Button aria-label={`Copy gateway ID ${gatewayModelId}`} size="icon-sm" variant="outline" className="shrink-0" onClick={() => { void copy(gatewayModelId, "Gateway ID copied") }}><CopyIcon /></Button></div></TableCell>
                  <TableCell>{model.upstreamModel}</TableCell>
                  {showProtocol && <TableCell>{protocolLabels[provider.protocol]}</TableCell>}
                  <TableCell><Badge variant={status === "Available" ? "secondary" : "outline"}>{status}</Badge>{unavailable && <span title="No connected account currently lists this model." aria-label="No connected account currently lists this model." tabIndex={0}><InfoIcon className="ml-1 inline size-3.5 text-muted-foreground" /></span>}</TableCell>
                  <TableCell><div className="flex items-center justify-end gap-1">{discovered && !unavailable && <Button size="icon-sm" variant="outline" aria-label={`${model.enabled ? "Disable" : "Enable"} ${model.name}`} aria-pressed={model.enabled} onClick={() => void toggleDiscoveredModel(model)}><PowerIcon /></Button>}<ModelShareButton modelId={model.id} modelName={model.name} disabled={!model.enabled || unavailable || !provider.enabled} onSaved={mutate} />{unavailable && (model.removalBlockers?.length ? <span className="max-w-60 whitespace-normal text-xs text-muted-foreground">Remove from {model.removalBlockers.join(", ")} first.</span> : <ConfirmAction title={`Remove ${model.name} from this list?`} buttonLabel="Remove" description="Past requests, usage, and costs will be kept." pending={isPending(pendingKey)} onConfirm={() => deleteModel(model)} />)}{!discovered && <><Button aria-label={`Edit ${model.name}`} size="icon-sm" variant="outline" onClick={() => { setEditingModel(model); setModelOpen(true) }}><PencilIcon /></Button><ConfirmAction title={`Delete ${model.name}?`} description={`This permanently removes the ${model.name} mapping.`} pending={isPending(pendingKey)} onConfirm={() => deleteModel(model)}><Trash2Icon /></ConfirmAction></>}</div></TableCell>
                </TableRow>
              })}
              {!models.length && <EmptyTableRow title="No models yet" description="Add a model mapping to expose an upstream model through this provider." icon={BoxesIcon} colSpan={showProtocol ? 6 : 5} />}
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

  const showQuota = isOAuthProvider && apiKey.credentialKind === "codex-oauth"
  const accountUsage = usageData?.accounts[apiKey.id]
  const rowError = showQuota ? codexUsageError(accountUsage, usageError?.message) : undefined
  const orderCell = <AccountOrderCell apiKey={apiKey} index={index} apiKeyCount={apiKeyCount} isPending={isPending} moveProviderApiKey={moveProviderApiKey} />
  const codexActionCell = <CodexAccountActions apiKey={apiKey} isPending={isPending} setToggleAccount={setToggleAccount} deleteCodexAccount={deleteCodexAccount} />
  if (provider.prefix === "codex" && rowError) return <TableRow key={apiKey.id} variant="error">{orderCell}<TableCell colSpan={6} density="comfortable"
            className="whitespace-normal"><div className="flex min-w-0 flex-col gap-1"><span className="font-medium text-destructive">{apiKey.name}</span><span className="break-words text-sm text-destructive">{rowError}</span></div></TableCell>{codexActionCell}</TableRow>
  return <TableRow key={apiKey.id} variant={apiKey.enabled ? "default" : "disabled"}>
      {orderCell}
      <TableCell text="label">{apiKey.name}</TableCell>
      <ProviderKeyMetadata apiKey={apiKey} isOAuthProvider={isOAuthProvider} accountUsage={accountUsage} usageLoading={usageLoading && !usageData} />
      {isOAuthProvider && (showQuota ? <CodexQuotaTableCell accountUsage={accountUsage} loading={usageLoading && !usageData} error={usageError?.message} /> : <TableCell tone="muted">N/A</TableCell>)}
      {isOAuthProvider && <AccountResetCell apiKey={apiKey} usageData={usageData} isPending={isPending} setResetAccount={setResetAccount} />}
      <TableCell text="small" tone="muted" className="align-middle">{formatAppDate(apiKey.createdAt)}</TableCell>
      {provider.prefix === "codex" ? codexActionCell : <TableCell density="flush" className="align-middle"><div className="flex items-center justify-end gap-1"><Button aria-label={`Edit ${apiKey.name}`} size="icon-sm" variant="outline" onClick={() => editApiKey(apiKey)}><PencilIcon /></Button><Button aria-label={`${apiKey.enabled ? "Disable" : "Enable"} ${apiKey.name}`} aria-busy={isPending(`toggle-provider-api-key:${apiKey.id}`)} size="icon-sm" variant="outline" disabled={isPending(`toggle-provider-api-key:${apiKey.id}`)} onClick={() => setToggleAccount(apiKey)}><PowerIcon /></Button><ConfirmAction title={`Delete ${apiKey.name}?`} description="Requests currently routed through this key will fail." pending={isPending(pendingKey)} onConfirm={() => deleteProviderApiKey(apiKey)}><Trash2Icon /></ConfirmAction></div></TableCell>}
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

function CredentialToggleDialog({ toggleAccount, setToggleAccount, isPending, onToggle }: {
  toggleAccount: ProviderApiKey | null
  setToggleAccount: (account: ProviderApiKey | null) => void
  isPending: (key: string) => boolean
  onToggle: (account: ProviderApiKey) => Promise<boolean>
}) {
  const isCodex = toggleAccount?.credentialKind === "codex-oauth"
  const pendingKey = `${isCodex ? "toggle-codex-account" : "toggle-provider-api-key"}:${toggleAccount?.id}`
  return <AlertDialog open={Boolean(toggleAccount)} onOpenChange={(open) => { if (!open && !isPending(pendingKey)) setToggleAccount(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{toggleAccount?.enabled ? "Disable" : "Enable"} {isCodex ? "Codex account" : "API key"}?</AlertDialogTitle><AlertDialogDescription>{toggleAccount?.enabled ? `Requests will stop using ${toggleAccount.name} until you enable it again.` : `Requests can use ${toggleAccount?.name} again.`}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={isPending(pendingKey)}>Cancel</AlertDialogCancel><AlertDialogAction aria-busy={isPending(pendingKey)} disabled={isPending(pendingKey)} onClick={async () => { if (toggleAccount && await onToggle(toggleAccount)) setToggleAccount(null) }}>{isPending(pendingKey) && <LoadingSpinner />}{toggleAccount?.enabled ? (isCodex ? "Disable account" : "Disable key") : (isCodex ? "Enable account" : "Enable key")}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
}

function AccountOrderCell({ apiKey, index, apiKeyCount, isPending, moveProviderApiKey }: Pick<ProviderKeyRowProps, "apiKey" | "index" | "apiKeyCount" | "isPending" | "moveProviderApiKey">) {
  const moveUpPending = isPending(`move-provider-api-key:${apiKey.id}:-1`)
  const moveDownPending = isPending(`move-provider-api-key:${apiKey.id}:1`)
  return <TableCell className="align-middle"><div className="flex items-center gap-0.5"><Button aria-label={`Move ${apiKey.name} up`} aria-busy={moveUpPending} title="Move up" size="icon-xs" variant="outline" disabled={index === 0 || moveUpPending || moveDownPending} onClick={() => void moveProviderApiKey(index, -1)}>{moveUpPending ? <LoadingSpinner /> : <ChevronUpIcon />}</Button><Button aria-label={`Move ${apiKey.name} down`} aria-busy={moveDownPending} title="Move down" size="icon-xs" variant="outline" disabled={index === apiKeyCount - 1 || moveUpPending || moveDownPending} onClick={() => void moveProviderApiKey(index, 1)}>{moveDownPending ? <LoadingSpinner /> : <ChevronDownIcon />}</Button></div></TableCell>
}

function CodexAccountActions({ apiKey, isPending, setToggleAccount, deleteCodexAccount }: Pick<ProviderKeyRowProps, "apiKey" | "isPending" | "setToggleAccount" | "deleteCodexAccount">) {
  return <TableCell density="flush" className="align-middle"><div className="flex items-center justify-end gap-1"><Button aria-label={`${apiKey.enabled ? "Disable" : "Enable"} ${apiKey.name}`} aria-busy={isPending(`toggle-codex-account:${apiKey.id}`)} size="icon-sm" variant="outline" disabled={apiKey.credentialKind !== "codex-oauth" || isPending(`toggle-codex-account:${apiKey.id}`)} onClick={() => setToggleAccount(apiKey)}><PowerIcon /></Button><ConfirmAction title={`Remove ${apiKey.name}?`} description={"This deletes the Codex account. You can connect it again later."} pending={isPending(`delete-codex-account:${apiKey.id}`)} onConfirm={() => deleteCodexAccount(apiKey)}><Trash2Icon /></ConfirmAction></div></TableCell>
}

function AccountResetCell({ apiKey, usageData, isPending, setResetAccount }: Pick<ProviderKeyRowProps, "apiKey" | "usageData" | "isPending" | "setResetAccount">) {
  const accountUsage = usageData?.accounts[apiKey.id]
  return <TableCell className="align-middle">{(accountUsage?.unusedResetCredits ?? 0) > 0 ? <div className="flex items-center gap-2"><span className="tabular-nums">{accountUsage?.unusedResetCredits}</span>{accountUsage && <CodexResetCreditsInfo usage={accountUsage} />}{apiKey.credentialKind === "codex-oauth" && <Button aria-busy={isPending(`reset:${apiKey.id}`)} size="sm" variant="outline" disabled={accountUsage?.weekly?.remainingPercent !== 0 || isPending(`reset:${apiKey.id}`)} title="Requires an exhausted weekly quota" onClick={() => setResetAccount(apiKey)}>{isPending(`reset:${apiKey.id}`) ? <LoadingSpinner /> : <RotateCcwIcon />}Redeem</Button>}</div> : <span className="text-muted-foreground">Not Available</span>}</TableCell>
}

function ProviderDetailsCard({ data, isOAuthProvider, mutate, refreshing }: { data: ProviderDetailResponse; isOAuthProvider: boolean; mutate: KeyedMutator<ProviderDetailResponse>; refreshing: boolean }) {
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
      navigate(pagePaths.providers)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(pendingKey); return next })
    }
  }
  return <Card className="relative" aria-busy={refreshing || undefined}>
        {refreshing && <RefreshScrim />}
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
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            <DetailFact label="Gateway prefix" value={`${provider.prefix}/`} mono />
            <DetailFact label="Protocol" value={protocolLabels[provider.protocol]} />
            <DetailFact label="Authentication" value={provider.authType === "none" ? "None" : provider.authType} />
            {provider.protocol !== "anthropic-messages" && <DetailFact label="Prompt cache key" value={provider.prefix === "codex" || provider.supportPromptCacheKey === true ? "Enabled" : "Disabled"} dim />}
            {provider.protocol === "openai-responses" && <DetailFact label="Reasoning summaries" value={provider.reasoningSummaries === true ? "Enabled" : "Disabled"} tone={provider.reasoningSummaries === true ? "success" : "neutral"} />}
            <DetailFact label={isOAuthProvider ? "Configured accounts" : "Configured keys"} value={String(apiKeyCounts.configured)} />
            <DetailFact label="Configured models" value={String(models.length)} />
          </div>
        </CardContent>
      </Card>
}

function DetailFact({ label, value, mono, dim, tone }: { label: string; value: string; mono?: boolean; dim?: boolean; tone?: "success" | "neutral" }) {
  return <div>
    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
    <div className="mt-1 text-sm font-medium">{tone
      ? <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${tone === "success" ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}>{value}</span>
      : <span className={`${mono ? "font-mono" : ""} ${dim ? "text-muted-foreground" : ""}`}>{value}</span>}</div>
  </div>
}

function ProviderCredentialsHeader({ provider, isOAuthProvider, login, onAdd }: { provider: Provider; isOAuthProvider: boolean; login: ReturnType<typeof useCodexLogin>; onAdd: () => void }) {
  const { device, starting, connect } = login
  return <CardHeader>
          <CardTitle variant="icon"><KeyRoundIcon className="size-5" />{isOAuthProvider ? "Accounts" : "API keys"}</CardTitle>
          <CardDescription>{provider.prefix === "codex" ? "Accounts are tried from top to bottom." : "Keys are selected automatically. When keys are equally busy, higher keys are preferred."}</CardDescription>
          <CardAction>{provider.prefix === "codex" ? <Button aria-busy={starting} onClick={() => void connect()} disabled={starting || Boolean(device)}>{starting ? <LoadingSpinner /> : <LogInIcon />}Add Codex Account</Button> : <Button disabled={provider.authType === "none"} onClick={onAdd}><PlusIcon />Add API key</Button>}</CardAction>
        </CardHeader>
}

function ProviderKeyMetadata({ apiKey, isOAuthProvider, accountUsage, usageLoading }: Pick<ProviderKeyRowProps, "apiKey" | "isOAuthProvider" | "usageLoading"> & { accountUsage?: UsageResponse["accounts"][string] }) {
  return <><TableCell>{isOAuthProvider ? <CodexPlanBadge accountUsage={accountUsage} loading={usageLoading} /> : <span className="text-sm text-muted-foreground">{apiKey.rpmLimit !== undefined ? `${apiKey.rpmLimit} rpm` : "—"}<span className="mx-2 text-border">·</span>{apiKey.maxConcurrency !== undefined ? `${apiKey.maxConcurrency} concurrent` : "—"}</span>}</TableCell>
                    <TableCell><Badge variant={apiKey.enabled ? "secondary" : "outline"}>{apiKey.enabled ? "Enabled" : "Disabled"}</Badge></TableCell></>
}

export function ProviderDetailView({ providerId }: { providerId: string }) {
  const { fetcher } = useDashboardApi()
  const { data, error, isLoading, mutate } = useSWR<ProviderDetailResponse>(providerKey(providerId), fetcher, { refreshInterval: providerId === "codex" ? 15000 : 0 })
  const [refreshing, setRefreshing] = useState(false)
  // Action-driven refetches surface the overlay; the Codex interval poll stays silent.
  const refreshProvider = () => { setRefreshing(true); return mutate().finally(() => setRefreshing(false)) }
  if (error) return <NotFoundState backHref={pagePaths.providers} />
  if (isLoading || !data) return <DashboardContentSkeleton variant={providerId === "codex" ? "codex-detail" : "provider-detail"} />
  return <ProviderDetailContent providerId={providerId} data={data} mutate={refreshProvider} refreshing={refreshing} />
}
