const realFetch = globalThis.fetch.bind(globalThis)

function fakeIdToken() {
  const payload = Buffer.from(JSON.stringify({
    email: "codex@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-e2e-codex", plan_type: "pro" },
  })).toString("base64url")
  return `eyJhbGciOiJub25lIn0.${payload}.signature`
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase()

  if (url.origin === "https://auth.openai.com" && url.pathname === "/oauth/token" && method === "POST") {
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "")
    if (body.get("grant_type") !== "authorization_code" || body.get("code") !== "e2e-code") {
      return Response.json({ error: "invalid_grant" }, { status: 400 })
    }
    return Response.json({ access_token: "e2e-access-token", refresh_token: "e2e-refresh-token", id_token: fakeIdToken(), expires_in: 3600 })
  }

  if (url.origin === "https://chatgpt.com") {
    if (url.pathname === "/backend-api/codex/models" && method === "GET") {
      return Response.json({ models: [{ slug: "gpt-5.4", display_name: "GPT 5.4", visibility: "list", supported_in_api: true }] })
    }
    if (url.pathname === "/backend-api/wham/usage" && method === "GET") {
      return Response.json({
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 18_000 },
          secondary_window: { used_percent: 100, limit_window_seconds: 604_800, reset_at: Math.floor(Date.now() / 1000) + 604_800 },
        },
      })
    }
    if (url.pathname === "/backend-api/wham/rate-limit-reset-credits" && method === "GET") {
      return Response.json({ credits: [{ id: "e2e-reset-credit", status: "available", expires_at: "2099-11-06T22:59:00Z" }] })
    }
    if (url.pathname === "/backend-api/wham/rate-limit-reset-credits/consume" && method === "POST") {
      return Response.json({ ok: true })
    }
  }

  return realFetch(input, init)
}) as typeof fetch
