import { findIndexedApiKeyByValue } from "./store"
import type { AuthenticatedGatewayKey } from "../contracts/domain"
import { getWorkspace } from "@rawroute/platform/server/runtime"

export async function authenticateProxyKey(request: Request) {
  const authorization = request.headers.get("authorization")
  const supplied = authorization?.slice(0, 7).toLowerCase() === "bearer "
    ? authorization.slice(7)
    : request.headers.get("x-api-key")
  if (!supplied) return undefined
  const indexed = await findIndexedApiKeyByValue(supplied)
  if (!indexed) return undefined
  const workspace = await getWorkspace(indexed.workspaceId)
  if (!workspace || workspace.status !== "active") return undefined
  return { workspace, apiKey: indexed.apiKey } satisfies AuthenticatedGatewayKey
}

export async function validateProxyKey(request: Request) {
  return Boolean(await authenticateProxyKey(request))
}
