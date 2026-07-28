export function jsonError(message: string, status: number, details?: unknown) {
  return Response.json({ error: { message, details } }, { status })
}

export function cleanId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}
