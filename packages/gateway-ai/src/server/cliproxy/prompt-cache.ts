import { createHash } from "node:crypto"

function identity(headers: Headers, names: string[]) {
  for (const name of names) {
    const value = headers.get(name)?.trim()
    if (value && value.length <= 512) return value
  }
  return undefined
}

export function withSessionPromptCacheKey(payload: Record<string, unknown>, headers: Headers, workspaceId: string, gatewayKeyId: string) {
  // Explicit client/provider policy wins, including invalid values for upstream validation.
  if (Object.hasOwn(payload, "prompt_cache_key")) return payload
  const session = identity(headers, ["session-id", "session_id", "x-session-id", "x-conversation-id", "thread-id", "x-thread-id"])
  if (!session) return payload
  const branch = identity(headers, ["x-claude-code-agent-id", "x-slot-session-id", "x-thread-id", "thread-id"])
  // Use consumer scope, never the shared provider's owner or a per-attempt ID.
  const key = createHash("sha256").update(JSON.stringify(["rawroute:prompt-cache:v1", workspaceId, gatewayKeyId, session, branch ?? null])).digest("hex")
  return { ...payload, prompt_cache_key: key }
}
