import styles from "../not-found.css" with { type: "text" }
import { renderToStaticMarkup } from "react-dom/server"
import { NotFoundPage } from "@/pages/not-found"
import { jsonError } from "@/lib/http"

const html = '<!doctype html>' + renderToStaticMarkup(<html lang="en"><head>
  <meta charSet="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <meta name="color-scheme" content="light dark" />
  <title>Page not found · RawRoute</title>
  <link rel="stylesheet" href="/not-found.css" />
</head><body><NotFoundPage /></body></html>)

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
