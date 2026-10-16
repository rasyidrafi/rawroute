import { getKeyUsagePayload } from "@/lib/analytics"
import { jsonError } from "@/lib/http"

export async function GET(_request: Request, { keyId }: { keyId: string }) {
  if (!keyId || keyId.length > 512) return jsonError("Invalid key ID.", 400)
  try { return Response.json(await getKeyUsagePayload(keyId)) }
  catch { return jsonError("Unable to load key usage.", 500) }
}
