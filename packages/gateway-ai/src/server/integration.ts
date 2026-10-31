import { initializeGatewayIdentity, identitySigningChanged } from "./store"
import { aiDocumentIntegration, initializeAiPersistence } from "./local-db"
import { cleanupAiWorkspaceResources } from "./workspace-cleanup"
import { authenticateProxyKey } from "./auth"
import { startCodexResetAutomation, stopCodexResetAutomation } from "./codex/reset"
import { scheduleCodexModelRefresh } from "./codex/model-refresh"
import { listProviders } from "./store"
import { drainGatewayExecutions } from "./gateway/admission"
import { mapConcurrent } from "@rawroute/platform/server/concurrency"
import { listWorkspaces } from "@rawroute/platform/server/runtime"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"
import type { GatewayAuthentication } from "@rawroute/platform/contracts/request-identity"

async function startAiServer() {
  await mapConcurrent((await listWorkspaces()).filter(workspace => workspace.status === "active"), 4, workspace => runInWorkspace(workspace, async () => {
    if ((await listProviders()).some(provider => provider.prefix === "codex")) scheduleCodexModelRefresh(true)
  }))
  startCodexResetAutomation()
}

async function stopAiServer() {
  await stopCodexResetAutomation()
  await drainGatewayExecutions()
}

/** Explicit integration surface: no mutable repository or transport secrets escape. */
export const aiServer = {
  documentIntegration: aiDocumentIntegration,
  initializePersistence: initializeAiPersistence,
  identity: { initialize: initializeGatewayIdentity, changed: identitySigningChanged },
  deletionParticipant: { id: "ai", cleanup: cleanupAiWorkspaceResources },
  start: startAiServer,
  stop: stopAiServer,
}

export const authenticateGatewayIdentity: GatewayAuthentication = async request => {
  const verified = await authenticateProxyKey(request)
  return verified ? { workspace: verified.workspace, credentialId: verified.apiKey.id } : undefined
}
