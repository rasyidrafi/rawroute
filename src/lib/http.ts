export function jsonError(message: string, status: number, details?: unknown) {
  return Response.json({ error: { message, details } }, { status })
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

export function cleanId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}

export function gatewayModelId(prefix: string, suffix: string) {
  const cleanSuffix = cleanId(suffix.includes("/") ? suffix.slice(suffix.lastIndexOf("/") + 1) : suffix)
  if (!cleanSuffix) throw new Error("Gateway model ID is required.")
  return `${cleanId(prefix)}/${cleanSuffix}`
}
