export type PendingCliProxyCodexLogin = { authFiles: string[]; expiresAt: number }

const pending = new Map<string, PendingCliProxyCodexLogin>()

export function savePendingCliProxyCodexLogin(id: string, value: PendingCliProxyCodexLogin) {
  pending.set(id, value)
}

export function takePendingCliProxyCodexLogin(id: string) {
  const value = pending.get(id)
  if (!value || value.expiresAt < Date.now()) {
    pending.delete(id)
    return undefined
  }
  return value
}

export function deletePendingCliProxyCodexLogin(id: string) {
  pending.delete(id)
}
