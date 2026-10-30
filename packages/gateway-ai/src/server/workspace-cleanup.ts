import { cleanupAiWorkspace, listProviders, listProviderApiKeys } from "./store"
import { cleanupWorkspaceAnalytics } from "./analytics"
import { cleanupWorkspacePricing } from "./model-pricing"
import { cleanupWorkspaceModelShares } from "./model-shares"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { runWorkspaceCleanup } from "@rawroute/platform/server/workspace-activity"
import { deleteCliProxyCodexAccount, mappedWorkspaceForFile } from "./codex/cliproxy"
import { cleanupWorkspaceCodexLogin } from "./codex/cli-login"
import { removeWorkspaceProviderProjection } from "./cliproxy/provider-sync"
import { localCacheDelete } from "@rawroute/platform/server/local-cache"
import { mapConcurrent } from "@rawroute/platform/server/concurrency"
import { invalidateCodexUsageCache } from "./codex/usage"
import { DEFAULT_WORKSPACE_ID } from "@rawroute/platform/contracts/workspace"
import { cleanupCodexResetWorkspace } from "./codex/reset"

/** AI owns only attributed resources. Never change the shared Tools deployment. */
export function cleanupAiWorkspaceResources(workspaceId: string) {
  if (workspaceId === DEFAULT_WORKSPACE_ID) throw new Error("Default workspace cannot be deleted.")
  return runWorkspaceCleanup(workspaceId, () => runInWorkspace({ id: workspaceId }, async () => {
    await cleanupWorkspaceCodexLogin(workspaceId)
    // Keep canonical mappings until remote cleanup succeeds, so retries can
    // find the same owned resources after a restart.
    await mapConcurrent(await listProviders(), 1, async provider => {
      if (provider.prefix !== "codex") await removeWorkspaceProviderProjection(provider.id)
      await mapConcurrent(await listProviderApiKeys(provider.id), 1, async account => {
        await invalidateCodexUsageCache(account.id)
        if (account.credentialKind === "codex-cli-proxy" && account.cliProxyAuthFile && !(await mappedWorkspaceForFile(account.cliProxyAuthFile, workspaceId))) await deleteCliProxyCodexAccount(account)
      })
    })
    await cleanupWorkspaceModelShares(workspaceId)
    cleanupCodexResetWorkspace(workspaceId)
    const complete = await cleanupAiWorkspace(workspaceId)
    complete()
    cleanupWorkspaceAnalytics(workspaceId)
    cleanupWorkspacePricing(workspaceId)
    await localCacheDelete(`rawroute:codex-models:${workspaceId}:status`)
    await localCacheDelete(`rawroute:codex-models:${workspaceId}:status:lock`)
  }))
}
