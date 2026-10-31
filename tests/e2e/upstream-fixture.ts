// Direct provider fixtures keep browser tests local and deterministic.
type RoutingMode = "cooldown-once" | "always-cooldown" | "ambiguous-429"
const state = { routingAttempts: 0, routingMode: undefined as RoutingMode | undefined }

async function handleRequest(request: Request) {
  const url = new URL(request.url)
  const path = url.pathname
  if (path === "/health" || path === "/executor/api/health") return Response.json({ status: "ok" })
  if (path === "/reset" && request.method === "POST") {
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

  if (path === "/v1/responses" && request.method === "POST") {
    state.routingAttempts++
    if (state.routingMode === "ambiguous-429") return Response.json({ error: { code: "upstream_error", message: "Temporary provider failure" } }, { status: 429, headers: { "retry-after": "3700" } })
    const cooldown = state.routingMode === "always-cooldown" || state.routingMode === "cooldown-once" && state.routingAttempts === 1
    if (cooldown) return Response.json({ error: { code: "model_cooldown", message: "Provider quota is temporarily unavailable", resets_in_seconds: 3700 } }, { status: 429, headers: { "retry-after": "3700" } })
    return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}\n\n', { headers: { "content-type": "text/event-stream" } })
  }
  return Response.json({ error: "Not found" }, { status: 404 })
}

Bun.serve({ hostname: "127.0.0.1", port: 3211, fetch: handleRequest })
console.log("Local upstream fixtures listening on 127.0.0.1:3211")
