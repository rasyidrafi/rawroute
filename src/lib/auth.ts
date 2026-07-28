import { createHmac, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"

import { readData } from "@/lib/store"

const COOKIE_NAME = "rawroute_session"

function sign(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url")
}

export async function createSession() {
  const data = await readData()
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 7
  const value = `${expiresAt}.${sign(String(expiresAt), data.sessionSecret)}`
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
  const data = await readData()
  const expected = sign(expires, data.sessionSecret)
  const left = Buffer.from(signature)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function requireAdmin() {
  if (!(await isAuthenticated())) throw new Error("UNAUTHORIZED")
}

export async function validateProxyKey(request: Request) {
  const authorization = request.headers.get("authorization")
  const supplied = authorization?.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7)
    : request.headers.get("x-api-key")
  if (!supplied) return false
  const data = await readData()
  return data.apiKeys.some((entry) => entry.key === supplied)
}
