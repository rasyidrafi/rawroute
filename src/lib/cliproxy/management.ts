import { cliproxyBaseUrl, cliproxySecret } from "@/server/cliproxy/connection"

export async function cliproxyManagement(path: string, init: RequestInit = {}) {
  if (!path.startsWith("/v0/management/") || path.includes("..") || path.includes("\\")) throw new Error("Invalid CLIProxy management path.")
  const headers = new Headers(init.headers)
  const managementKey = cliproxySecret("managementKey")
  if (managementKey) headers.set("x-management-key", managementKey)
  return fetch(`${cliproxyBaseUrl()}${path}`, {
    ...init,
    headers,
    cache: "no-store",
    signal: init.signal ?? AbortSignal.timeout(15_000),
  })
}

export async function cliproxyManagementJson<T>(path: string, init: RequestInit = {}) {
  const response = await cliproxyManagement(path, init)
  const data = await response.json().catch(() => undefined) as T | undefined
  return { response, data }
}
