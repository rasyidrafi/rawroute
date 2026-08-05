import { createServer } from "node:http"

type State = {
  pollCount: number
  upstreamBody?: Record<string, unknown>
  upstreamHeaders?: Record<string, string>
}

const state: State = { pollCount: 0 }
const idToken = `header.${Buffer.from(JSON.stringify({
  email: "codex@example.com",
  exp: Math.floor(Date.now() / 1000) + 3600,
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "pro" },
})).toString("base64url")}.signature`

function json(value: unknown, status = 200) {
  return Response.json(value, { status })
}

async function handleRequest(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")
    if (url.pathname === "/reset" && request.method === "POST") {
      state.pollCount = 0
      state.upstreamBody = undefined
      state.upstreamHeaders = undefined
      return json({ ok: true })
    }
    if (url.pathname === "/debug") return json(state)
    if (url.pathname === "/api/accounts/deviceauth/usercode") {
      return json({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: 1 })
    }
    if (url.pathname === "/api/accounts/deviceauth/token") {
      state.pollCount += 1
      if (state.pollCount === 1) return new Response("pending", { status: 403 })
      return json({ authorization_code: "authorization-code", code_verifier: "code-verifier", code_challenge: "code-challenge" })
    }
    if (url.pathname === "/oauth/token") {
      const body = await request.text()
      if (body.includes("grant_type=refresh_token")) {
        return json({ access_token: "refreshed-access", refresh_token: "refreshed-refresh", id_token: idToken, expires_in: 3600 })
      }
      return json({ access_token: "access-token", refresh_token: "refresh-token", id_token: idToken, expires_in: 3600 })
    }
    if (url.pathname === "/codex/responses" && request.method === "POST") {
      state.upstreamBody = await request.json() as Record<string, unknown>
      state.upstreamHeaders = Object.fromEntries(request.headers.entries())
      return new Response("data: {\"type\":\"response.completed\"}\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    }
    return json({ error: "Not found" }, 404)
}

const server = createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
  const body = Buffer.concat(chunks)
  const request = new Request(`http://127.0.0.1:3211${incoming.url}`, {
    method: incoming.method,
    headers: incoming.headers as HeadersInit,
    body: body.length ? body : undefined,
  })
  const response = await handleRequest(request)
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  outgoing.end(Buffer.from(await response.arrayBuffer()))
})

server.listen(3211, "127.0.0.1", () => {
  console.log("Codex auth mock listening on 127.0.0.1:3211")
})
