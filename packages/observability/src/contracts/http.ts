export function jsonError(message: string, status: number, details?: unknown) {
  return Response.json({ error: { message, details } }, { status })
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}
