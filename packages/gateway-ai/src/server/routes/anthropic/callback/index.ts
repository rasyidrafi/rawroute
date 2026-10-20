import { proxyAiOAuthCallback } from "../../../oauth-callback"

export async function GET(request: Request) {
  return proxyAiOAuthCallback(request, "/anthropic/callback")
}
