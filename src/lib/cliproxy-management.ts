const DEFAULT_CLIPROXY_URL = "http://cli-proxy-api:8317"

function upstreamUrl(path: string) {
  const base = (process.env.CLIPROXY_URL || DEFAULT_CLIPROXY_URL).replace(/\/$/, "")
  return `${base}${path.startsWith("/") ? path : `/${path}`}`
}

export async function cliproxyManagement(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const managementKey = process.env.CLIPROXY_MANAGEMENT_KEY?.trim()
  if (managementKey) headers.set("x-management-key", managementKey)
  return fetch(upstreamUrl(path), {
    ...init,
    headers,
    cache: "no-store",
  })
}

export async function cliproxyManagementJson<T>(path: string, init: RequestInit = {}) {
  const response = await cliproxyManagement(path, init)
  const data = await response.json().catch(() => undefined) as T | undefined
  return { response, data }
}
