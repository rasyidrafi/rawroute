import { createHmac, timingSafeEqual } from "node:crypto"
import { cookies, headers } from "next/headers"

import { findIndexedApiKeyByValue, readSessionSecret } from "@/lib/store"
import type { AuthenticatedGatewayKey, Workspace } from "@/lib/types"
import { DEFAULT_WORKSPACE_ID, enterWorkspace } from "@/lib/workspace-context"
import { getWorkspace } from "@/lib/workspaces"

const COOKIE_NAME = "rawroute_session"

function sign(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url")
}

export async function createSession() {
  const sessionSecret = await readSessionSecret()
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 7
  const value = `${expiresAt}.${sign(String(expiresAt), sessionSecret)}`
  const jar = await cookies()
  jar.set(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  })
}

export async function destroySession() {
  const jar = await cookies()
  jar.delete(COOKIE_NAME)
}

export async function isAuthenticated() {
  const jar = await cookies()
  const value = jar.get(COOKIE_NAME)?.value
  if (!value) return false
  const [expires, signature] = value.split(".")
  if (!expires || !signature || Number(expires) < Date.now()) return false
  const expected = sign(expires, await readSessionSecret())
  const left = Buffer.from(signature)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function requireAdmin() {
  if (!(await isAuthenticated())) throw new Error("UNAUTHORIZED")
  const workspaceId = (await headers()).get("x-rawroute-workspace-id")?.trim() || DEFAULT_WORKSPACE_ID
  const workspace = await getWorkspace(workspaceId)
  if (!workspace || workspace.status !== "active") throw new Error("WORKSPACE_UNAVAILABLE")
  return () => enterWorkspace(workspace)
}

export async function requireAdminWorkspace(request: Request): Promise<Workspace> {
  if (!(await isAuthenticated())) throw new Error("UNAUTHORIZED")
  const workspaceId = request.headers.get("x-rawroute-workspace-id")?.trim()
  if (!workspaceId) throw new Error("WORKSPACE_REQUIRED")
  const workspace = await getWorkspace(workspaceId)
  if (!workspace || workspace.status !== "active") throw new Error("WORKSPACE_UNAVAILABLE")
  enterWorkspace(workspace)
  return workspace
}

export async function authenticateProxyKey(request: Request) {
  const authorization = request.headers.get("authorization")
  const supplied = authorization?.slice(0, 7).toLowerCase() === "bearer "
    ? authorization.slice(7)
    : request.headers.get("x-api-key")
  if (!supplied) return undefined
  const indexed = await findIndexedApiKeyByValue(supplied)
  if (!indexed) return undefined
  // The index avoids reading the API-key document, while the bounded workspace
  // cache preserves the active/deleting check without adding a Firestore read
  // to warm proxy authentications.
  const workspace = await getWorkspace(indexed.workspaceId)
  if (!workspace || workspace.status !== "active") return undefined
  enterWorkspace(workspace)
  return { workspace, apiKey: indexed.apiKey } satisfies AuthenticatedGatewayKey
}

export async function validateProxyKey(request: Request) {
  return Boolean(await authenticateProxyKey(request))
}
