import { isAuthenticated } from "../../../../runtime"

export async function GET(request: Request) {
  return Response.json({ authenticated: await isAuthenticated(request) }, { headers: { "cache-control": "private, no-store" } })
}
