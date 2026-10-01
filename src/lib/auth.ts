import { createHmac, timingSafeEqual } from "node:crypto"

import { findIndexedApiKeyByValue, readSessionSecret } from "@/server/store"
import type { AuthenticatedGatewayKey } from "@/lib/types"
import { getWorkspace } from "@/server/workspace-repository"

const COOKIE_NAME = "rawroute_session"

function sign(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url")
}

type HeaderReader = { get(name: string): string | null }

export function isSecureSessionRequest(requestHeaders: HeaderReader) {
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase()
  if (forwardedProtocol) return forwardedProtocol === "https"
  const forwarded = requestHeaders.get("forwarded")?.match(/(?:^|[;,])\s*proto=([^;,]+)/i)?.[1]?.replace(/^"|"$/g, "").trim().toLowerCase()
  return forwarded === "https"
}

export async function createSession(request: Request) {
  const sessionSecret = await readSessionSecret()
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 7
  const value = `${expiresAt}.${sign(String(expiresAt), sessionSecret)}`
  return new Bun.Cookie(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(request.url).protocol === "https:" || isSecureSessionRequest(request.headers),
    path: "/",
    expires: new Date(expiresAt),
  }).serialize()
}

export function destroySession() {
  return new Bun.Cookie(COOKIE_NAME, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 }).serialize()
}

export async function isAuthenticated(request: Request) {
  const value = new Bun.CookieMap(request.headers.get("cookie") || "").get(COOKIE_NAME)
  if (!value) return false
  const [expires, signature, extra] = value.split(".")
  if (!expires || !signature || extra !== undefined || !Number.isSafeInteger(Number(expires)) || Number(expires) <= Date.now()) return false
  const expected = sign(expires, await readSessionSecret())
  const left = Buffer.from(signature)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
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
  return { workspace, apiKey: indexed.apiKey } satisfies AuthenticatedGatewayKey
}

export async function validateProxyKey(request: Request) {
  return Boolean(await authenticateProxyKey(request))
}
