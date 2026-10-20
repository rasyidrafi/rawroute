import styles from "../frontend/not-found.css" with { type: "text" }
import { pagePaths } from "../frontend/contracts/dashboard/routes"
import { jsonError } from "@rawroute/observability/contracts/http"


// Native fallback HTML must not pull React views into the server graph.
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex"/><meta name="color-scheme" content="light dark"/><title>Page not found · RawRoute</title><link rel="stylesheet" href="/not-found.css"/></head><body><main class="rawroute-not-found"><a class="nf-brand" href="/" aria-label="RawRoute home">RawRoute<span aria-hidden="true">.</span></a><section class="nf-content" aria-labelledby="not-found-title"><p class="nf-code" aria-hidden="true">404</p><h1 id="not-found-title">Page not found</h1><p class="nf-description">The page you’re looking for may have moved or is no longer available.</p><nav class="nf-actions" aria-label="Page recovery"><a class="nf-link nf-primary" href="${pagePaths.overview}">Go to overview <span aria-hidden="true">&nbsp;↗</span></a><a class="nf-link" href="/">Back to home</a></nav></section><footer><span>One gateway. Every model.</span><span>Error 404</span></footer></main></body></html>`

export function notFoundResponse(request: Request) {
  const { pathname } = new URL(request.url)
  const apiPath = /^\/(?:api|v\d+(?:beta)?|openai|backend-api|executor|model)(?:\/|$)/.test(pathname)
  const pageRequest = request.method === "GET" || request.method === "HEAD"
  const browserPage = request.headers.get("accept")?.includes("text/html") || /^\/dashboard(?:\/|$)/.test(pathname)
  if (!pageRequest || apiPath || !browserPage) return jsonError("Not found.", 404)
  return new Response(request.method === "HEAD" ? null : html, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", vary: "Accept" },
  })
}

export function notFoundStylesResponse(request: Request) {
  return new Response(request.method === "HEAD" ? null : styles, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" } })
}
