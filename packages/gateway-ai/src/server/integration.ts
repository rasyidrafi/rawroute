import { assertGatewayBootstrap, initializeGatewayIdentity, identitySigningChanged } from "./store"
import { initializeAiPersistence } from "./local-db"
import { cleanupAiWorkspaceResources } from "./workspace-cleanup"
import { authenticateProxyKey } from "./auth"
import { initializeInstance, shutdownInstance } from "./cliproxy/runtime"
import { cliProxyHealth } from "./cliproxy/gateway"
import type { GatewayAuthentication } from "@rawroute/platform/contracts/request-identity"

/** Explicit integration surface: no mutable repository or transport secrets escape. */
export const aiServer = {
  initializePersistence: initializeAiPersistence,
  identity: { validateBootstrap: assertGatewayBootstrap, initialize: initializeGatewayIdentity, changed: identitySigningChanged },
  deletionParticipant: { id: "ai", cleanup: cleanupAiWorkspaceResources },
  assertBootstrap: assertGatewayBootstrap,
  start: initializeInstance,
  stop: shutdownInstance,
  health: cliProxyHealth,
}

export const authenticateGatewayIdentity: GatewayAuthentication = async request => {
  const verified = await authenticateProxyKey(request)
  return verified ? { workspace: verified.workspace, credentialId: verified.apiKey.id } : undefined
}
