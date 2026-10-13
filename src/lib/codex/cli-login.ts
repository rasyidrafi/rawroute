import { localCacheCompareAndDelete, localCacheDelete, localCacheGet, localCacheSetIfAbsent } from "@/lib/local-cache"

export type PendingCliProxyCodexLogin = {
  state: string
  workspaceId: string
  authFiles: Record<string, string>
  expiresAt: number
}

const LOGIN_TTL_MS = 5 * 60 * 1000
const GLOBAL_LOGIN_LOCK = "rawroute:codex-login:v2:active"

function loginKey(id: string) {
  return `rawroute:codex-login:v2:session:${id}`
}

export async function reservePendingCliProxyCodexLogin(id: string) {
  const reserved = await localCacheSetIfAbsent(GLOBAL_LOGIN_LOCK, id, LOGIN_TTL_MS)
  if (!reserved) throw new Error("Another Codex login is already in progress. Finish or cancel it before starting another.")
}

export async function savePendingCliProxyCodexLogin(id: string, value: Omit<PendingCliProxyCodexLogin, "expiresAt">) {
  // OAuth state must survive ordinary cache pressure until completion/expiry.
  const saved = await localCacheSetIfAbsent(loginKey(id), JSON.stringify({ ...value, expiresAt: Date.now() + LOGIN_TTL_MS }), LOGIN_TTL_MS)
  if (!saved) {
    await localCacheCompareAndDelete(GLOBAL_LOGIN_LOCK, id)
    throw new Error("Unable to save the pending Codex login session.")
  }
}

export async function takePendingCliProxyCodexLogin(id: string) {
  const raw = await localCacheGet(loginKey(id))
  if (typeof raw !== "string" || !raw) return undefined
  try {
    const value = JSON.parse(raw) as Partial<PendingCliProxyCodexLogin>
    if (typeof value.state !== "string" || typeof value.workspaceId !== "string" || !value.authFiles || typeof value.authFiles !== "object" || typeof value.expiresAt !== "number" || value.expiresAt < Date.now()) {
      await deletePendingCliProxyCodexLogin(id)
      return undefined
    }
    return value as PendingCliProxyCodexLogin
  } catch {
    await deletePendingCliProxyCodexLogin(id)
    return undefined
  }
}

export async function deletePendingCliProxyCodexLogin(id: string) {
  await Promise.all([
    localCacheDelete(loginKey(id)),
    localCacheCompareAndDelete(GLOBAL_LOGIN_LOCK, id),
  ])
}

export async function hasPendingCodexLogin() { return Boolean(await localCacheGet(GLOBAL_LOGIN_LOCK)) }
