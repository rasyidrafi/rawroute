import { listModels } from "@/server/store"

export async function GET() {
  return Response.json({ models: await listModels() })
}
