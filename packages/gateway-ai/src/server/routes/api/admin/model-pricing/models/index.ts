import { listModels } from "../../../../../store"

export async function GET() {
  return Response.json({ models: await listModels() })
}
