import { listModels } from "@/lib/store"

export async function GET() {
  return Response.json({ models: await listModels() })
}
