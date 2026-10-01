// Private upstream fixtures exercise the current CLIProxy management contract.
// No provider request leaves this local test service.
type AuthFile = { name: string; type: string; auth_index: string; email: string; account_id: string; plan_type: string; prefix?: string; disabled: boolean; status: string }
type RoutingMode = "cooldown-once" | "always-cooldown" | "codex-cooldown" | "ambiguous-429"
const files: AuthFile[] = []
const sessions = new Map<string, boolean>()
const configuration: Record<string, unknown> = { "openai-compatibility": [], "claude-api-key": [], "routing/strategy": { strategy: "fill-first" } }
const gatewaySettings: Record<string, unknown> = { debug: false, "logging-to-file": false, "usage-statistics-enabled": false, "request-retry": 2, "max-retry-interval": 30 }
const state = { pollCount: 0, routingAttempts: 0, routingMode: undefined as RoutingMode | undefined }

async function handleRequest(request: Request) {
  const url = new URL(request.url)
  const path = url.pathname
  if (path === "/health" || path === "/cliproxy/healthz" || path === "/executor/api/health") return Response.json({ status: "ok" })
  if (path === "/reset" && request.method === "POST") {
    files.length = 0
    sessions.clear()
    state.pollCount = 0
    state.routingAttempts = 0
    state.routingMode = undefined
    return Response.json({ ok: true })
  }
  if (path === "/routing-mode" && request.method === "POST") {
    state.routingAttempts = 0
    state.routingMode = (await request.json() as { mode?: RoutingMode }).mode
    return Response.json({ ok: true })
  }
  if (path === "/debug") return Response.json(state)

  if (path.startsWith("/cliproxy/v0/management/")) {
    if (request.headers.get("x-management-key") !== "e2e-management-key") return Response.json({ error: "Unauthorized" }, { status: 401 })
    const endpoint = path.slice("/cliproxy/v0/management/".length)
    if (Object.hasOwn(gatewaySettings, endpoint) && request.method === "PUT") {
      gatewaySettings[endpoint] = (await request.json() as { value: unknown }).value
      return Response.json({ ok: true })
    }
    if (Object.hasOwn(configuration, endpoint)) {
      if (request.method === "PUT") {
        configuration[endpoint] = await request.json()
        return Response.json({ ok: true })
      }
      return Response.json(endpoint === "routing/strategy" ? configuration[endpoint] : { [endpoint]: configuration[endpoint] })
    }
    if (endpoint === "config") return Response.json({ ...gatewaySettings, routing: { strategy: "fill-first" } })
    if (endpoint === "codex-auth-url") {
      const id = crypto.randomUUID()
      sessions.set(id, false)
      return Response.json({ state: id, url: `http://127.0.0.1:3211/signin?state=${id}` })
    }
    if (endpoint === "oauth-session" && request.method === "DELETE") {
      sessions.delete(url.searchParams.get("state") || "")
      return Response.json({ ok: true })
    }
    if (endpoint === "oauth-callback") {
      const input = await request.json() as { state: string; code?: string }
      if (!sessions.has(input.state) || !input.code) return Response.json({ error: "Invalid callback" }, { status: 400 })
      sessions.set(input.state, true)
      files.push({ name: `codex-${input.state}.json`, type: "codex", auth_index: input.state, email: "codex@example.com", account_id: input.state, plan_type: "pro", disabled: false, status: "active" })
      return Response.json({ ok: true })
    }
    if (endpoint === "get-auth-status") {
      state.pollCount++
      return Response.json({ status: sessions.get(url.searchParams.get("state") || "") ? "ok" : "wait" })
    }
    if (endpoint === "auth-files") {
      if (request.method === "DELETE") {
        const index = files.findIndex((file) => file.name === url.searchParams.get("name"))
        if (index >= 0) files.splice(index, 1)
        return Response.json({ ok: true })
      }
      return Response.json({ files })
    }
    if (endpoint === "auth-files/fields" || endpoint === "auth-files/status") {
      const body = await request.json() as Partial<AuthFile> & { name: string }
      const file = files.find((entry) => entry.name === body.name)
      if (!file) return Response.json({ error: "Not found" }, { status: 404 })
      Object.assign(file, body)
      return Response.json({ ok: true })
    }
    if (endpoint === "auth-files/models") {
      const file = files.find((entry) => entry.name === url.searchParams.get("name"))
      return Response.json({ models: ["gpt-5.4", "gpt-5.3-codex"].map((id) => ({ id: `${file?.prefix}/${id}`, display_name: id })) })
    }
    if (endpoint === "api-call") {
      const input = await request.json() as { url: string }
      const usage = input.url.includes("rate-limit-reset-credits") ? { credits: [] } : {
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 18_000 },
          secondary_window: { used_percent: 20, limit_window_seconds: 604_800, reset_at: Math.floor(Date.now() / 1000) + 604_800 },
        },
      }
      return Response.json({ status_code: 200, body: JSON.stringify(usage) })
    }
  }
  if (["/cliproxy/v1/responses", "/cliproxy/v1/chat/completions"].includes(path) && request.method === "POST") {
    if (request.headers.get("authorization") !== "Bearer sk-e2e-internal") return Response.json({ error: "Unauthorized" }, { status: 401 })
    state.routingAttempts++
    if (state.routingMode === "ambiguous-429") return Response.json({ error: { code: "upstream_error", message: "Temporary provider failure" } }, { status: 429, headers: { "retry-after": "3700" } })
    const cooldown = state.routingMode === "always-cooldown" || state.routingMode === "codex-cooldown" || state.routingMode === "cooldown-once" && state.routingAttempts === 1
    if (cooldown) return Response.json({ error: { code: state.routingMode === "codex-cooldown" ? "codex_cooldown" : "model_cooldown", message: "All credentials for model are cooling down", reset_seconds: 3700 } }, { status: 429, headers: { "retry-after": "3700" } })
    return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}\n\n', { headers: { "content-type": "text/event-stream" } })
  }
  return Response.json({ error: "Not found" }, { status: 404 })
}

Bun.serve({ hostname: "127.0.0.1", port: 3211, fetch: handleRequest })
console.log("Private upstream mocks listening on 127.0.0.1:3211")
