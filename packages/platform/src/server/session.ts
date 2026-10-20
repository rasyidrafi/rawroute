import { timingSafeEqual } from "node:crypto"
import type { SignValue } from "../contracts/request-identity"

const COOKIE_NAME = "rawroute_session"

type HeaderReader = { get(name: string): string | null }

export function isSecureSessionRequest(requestHeaders: HeaderReader) {
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase()
  if (forwardedProtocol) return forwardedProtocol === "https"
  const forwarded = requestHeaders.get("forwarded")?.match(/(?:^|[;,])\s*proto=([^;,]+)/i)?.[1]?.replace(/^"|"$/g, "").trim().toLowerCase()
  return forwarded === "https"
}

export function createSessionAuthentication(sign: SignValue) {
  async function createSession(request: Request) {
    const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 7
    const value = `${expiresAt}.${await sign(String(expiresAt))}`
    return new Bun.Cookie(COOKIE_NAME, value, {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(request.url).protocol === "https:" || isSecureSessionRequest(request.headers),
      path: "/",
      expires: new Date(expiresAt),
    }).serialize()
  }

  function destroySession() {
    return new Bun.Cookie(COOKIE_NAME, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 }).serialize()
  }

  async function isAuthenticated(request: Request) {
    const value = new Bun.CookieMap(request.headers.get("cookie") || "").get(COOKIE_NAME)
    if (!value) return false
    const [expires, signature, extra] = value.split(".")
    if (!expires || !signature || extra !== undefined || !Number.isSafeInteger(Number(expires)) || Number(expires) <= Date.now()) return false
    const expected = await sign(expires)
    const left = Buffer.from(signature)
    const right = Buffer.from(expected)
    return left.length === right.length && timingSafeEqual(left, right)
  }

  return { createSession, destroySession, isAuthenticated }
}
