export function GET() {
  return Response.json({ version: process.env.DEPLOYMENT_VERSION || "development" }, { headers: { "cache-control": "no-store" } })
}
