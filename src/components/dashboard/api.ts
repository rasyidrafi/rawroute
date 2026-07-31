export class UnauthorizedError extends Error {
  constructor() { super("Unauthorized") }
}

async function parseError(response: Response) {
  if (response.status === 401) {
    if (typeof window !== "undefined") window.location.assign("/login")
    throw new UnauthorizedError()
  }
  let message = `Request failed (${response.status})`
  try {
    const body = await response.json() as { error?: { message?: string } }
    if (body.error?.message) message = body.error.message
  } catch {}
  throw new Error(message)
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init })
  if (!response.ok) await parseError(response)
  return response.json() as Promise<T>
}

export const fetcher = <T,>(url: string) => apiFetch<T>(url)

export async function apiPost<T = { ok: true }>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  if (!response.ok) await parseError(response)
  return response.json() as Promise<T>
}

export async function apiPatch<T = { ok: true }>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: "PATCH", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  if (!response.ok) await parseError(response)
  return response.json() as Promise<T>
}

export async function apiDelete<T = { ok: true }>(url: string): Promise<T> {
  const response = await fetch(url, { method: "DELETE", cache: "no-store" })
  if (!response.ok) await parseError(response)
  return response.json() as Promise<T>
}
