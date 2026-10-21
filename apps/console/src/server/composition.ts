import { configurePlatformServer } from "@rawroute/platform/server/runtime"
import { aiServer, authenticateGatewayIdentity } from "@rawroute/gateway-ai/server/integration"
import { configureToolsServer } from "@rawroute/gateway-tools/server/integration"
import { configureObservabilityServer } from "@rawroute/platform/server/operational-logs/integration"
import { toolsRecordLog } from "@rawroute/gateway-tools/server/logging"
import { logs } from "@rawroute/observability/server/store"
import { getWorkspace } from "@rawroute/platform/server/runtime"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { browserEventScope } from "../frontend/contracts/logging/browser-events"
import { installDocumentIntegrations } from "@rawroute/platform/server/database"
import { storageServer } from "@rawroute/gateway-storage/server/integration"

installDocumentIntegrations([aiServer.documentIntegration, storageServer.documentIntegration])
configurePlatformServer({
  identity: aiServer.identity,
  participants: [aiServer.deletionParticipant, storageServer.deletionParticipant, { id: "operational-logs", cleanup: async workspaceId => { logs.deleteWorkspace(workspaceId) } }],
})
configureToolsServer({ authenticate: authenticateGatewayIdentity, recordLog: toolsRecordLog })
configureObservabilityServer({ getWorkspace, runInWorkspace, browserEventScope })
