import { assertIdentityBootstrap } from "@rawroute/platform/server/identity"
import { aiServer } from "@rawroute/gateway-ai/server/integration"

export function assertProductionBootstrap(environment: Record<string, string | undefined>) {
  assertIdentityBootstrap(environment)
  aiServer.assertBootstrap(environment)
}
