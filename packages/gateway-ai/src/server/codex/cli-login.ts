import { localCacheCompareAndDelete, localCacheDelete, localCacheGet, localCacheSetIfAbsent } from "@rawroute/platform/server/local-cache"
import { withManagementMutation } from "../cliproxy/mutations"
import { getSqliteDatabase } from "@rawroute/platform/server/database"
import { collectionPrefix, isMemoryBackend } from "@rawroute/platform/server/storage-config"
import { mapConcurrent } from "@rawroute/platform/server/concurrency"

export type PendingCliProxyCodexLogin = {
  state: string
  workspaceId: string
  authFiles: Record<string, string>
  expiresAt: number
}

const LOGIN_TTL_MS = 5 * 60 * 1000
const GLOBAL_LOGIN_LOCK = "rawroute:codex-login:v2:active"
type PendingCancellation = Pick<PendingCliProxyCodexLogin, "state" | "workspaceId">
declare global { var __rawroutePendingCodexCancellations: Map<string, PendingCancellation> | undefined }
const memoryCancellations = () => globalThis.__rawroutePendingCodexCancellations ||= new Map<string, PendingCancellation>()
const cancellationsRef = () => getSqliteDatabase().collection(`${collectionPrefix()}_codex_login_cancellations`)

function loginKey(id: string) {
  return `rawroute:codex-login:v2:session:${id}`
}

export async function reservePendingCliProxyCodexLogin(id: string) {
  const reserved = await localCacheSetIfAbsent(GLOBAL_LOGIN_LOCK, id, LOGIN_TTL_MS)
  if (!reserved) throw new Error("Another Codex login is already in progress. Finish or cancel it before starting another.")
}

export async function savePendingCliProxyCodexLogin(id: string, value: Omit<PendingCliProxyCodexLogin, "expiresAt">) {
  // Separate cleanup ownership from the expiring interaction/lock. OAuth state
  // is sensitive operational data, not audit metadata; keep it until upstream
  // cancellation/absence or completed authorization is confirmed.
  const cancellation = { state: value.state, workspaceId: value.workspaceId }
  if (isMemoryBackend()) memoryCancellations().set(id, cancellation)
  else await cancellationsRef().doc(id).set(cancellation)
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

/** Only call after successful authorization or cancellation (including 404). */
export async function settlePendingCliProxyCodexLogin(id: string) {
  if (isMemoryBackend()) memoryCancellations().delete(id)
  else await cancellationsRef().doc(id).delete()
  await deletePendingCliProxyCodexLogin(id)
}

export async function hasPendingCodexLogin() { return Boolean(await localCacheGet(GLOBAL_LOGIN_LOCK)) }

export async function cleanupWorkspaceCodexLogin(workspaceId: string) {
  const pending = isMemoryBackend()
    ? [...memoryCancellations()].filter(([, value]) => value.workspaceId === workspaceId).map(([id, value]) => ({ id, ...value }))
    : (await cancellationsRef().where("workspaceId", "==", workspaceId).get()).docs.map(doc => ({ id: doc.id, ...doc.data() as PendingCancellation }))
  if (!pending.length) return
  // Local cache loss/TTL is not evidence of upstream expiry. DELETE success or
  // 404 is authoritative; all other failures retain attribution for recovery.
  const { cancelCliProxyCodexLogin } = await import("./cliproxy")
  await mapConcurrent(pending, 1, async login => {
    await withManagementMutation(() => cancelCliProxyCodexLogin(login.state))
    await settlePendingCliProxyCodexLogin(login.id)
  })
}
