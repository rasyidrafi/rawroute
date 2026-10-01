import { getAppTimeZone } from "@/lib/timezone"

export function GET() {
  return Response.json({ timeZone: getAppTimeZone(), version: process.env.DEPLOYMENT_VERSION || "development" }, { headers: { "cache-control": "no-store" } })
}
