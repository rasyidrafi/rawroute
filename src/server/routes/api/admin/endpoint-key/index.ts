import { listApiKeys } from "@/lib/store"

export async function GET() {
  const apiKeys = await listApiKeys()
  return Response.json({ endpoint: "/v1", apiKeys })
}
