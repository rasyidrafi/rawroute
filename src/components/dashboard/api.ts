export class UnauthorizedError extends Error {
  constructor() { super("Unauthorized") }
}

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly details?: unknown) { super(message) }
}

async function parseError(response: Response): Promise<never> {
  if (response.status === 401) {
    if (typeof window !== "undefined") window.location.assign(new URL("/login", window.location.origin).toString())
    throw new UnauthorizedError()
  }
  let message = `Request failed (${response.status})`
  let details: unknown
  try {
    const body = await response.json() as { error?: { message?: string; details?: unknown } }
    if (body.error?.message) message = body.error.message
    details = body.error?.details
  } catch {}
  throw new ApiRequestError(message, response.status, details)
}

/** A client captures its workspace once. Async follow-up calls cannot switch owners. */
export function createApiClient(workspaceId: string | null = null) {
  async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    if (workspaceId) headers.set("x-rawroute-workspace-id", workspaceId)
    else headers.delete("x-rawroute-workspace-id")
    const response = await fetch(url, { cache: "no-store", ...init, headers })
    if (!response.ok) return parseError(response)
    return response.json() as Promise<T>
  }
  function mutate<T>(method: string, url: string, body?: unknown) {
    return apiFetch<T>(url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) })
  }
  return {
    workspaceId,
    apiFetch,
    fetcher: <T,>(url: string) => apiFetch<T>(url),
    apiPost: <T = { ok: true },>(url: string, body: unknown) => mutate<T>("POST", url, body),
    apiPatch: <T = { ok: true },>(url: string, body: unknown) => mutate<T>("PATCH", url, body),
    apiDelete: <T = { ok: true },>(url: string, body?: unknown) => mutate<T>("DELETE", url, body),
  }
}

// Explicit global client for auth, settings and workspace administration.
export const { apiFetch, fetcher, apiPost, apiPatch, apiDelete } = createApiClient()
