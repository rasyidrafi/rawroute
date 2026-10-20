import { auditRemoteOperation } from "@rawroute/platform/server/audit"
import { proxyToCliProxy } from "./cliproxy/transport"

/** Upstream owns these callback sessions; never persist the code/state/URL. */
export function proxyAiOAuthCallback(request: Request, path: "/anthropic/callback" | "/antigravity/callback" | "/codex/callback") {
  return auditRemoteOperation({ action: "oauth.remote", resource: "oauth" }, () => proxyToCliProxy(request, path))
}
