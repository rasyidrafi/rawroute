import { managementRequest, boundedObject } from "./request"
import { managedService } from "./service-module"
import { z } from "zod"
import { jsonError } from "@/lib/http"
import { instanceStatus, runInstanceAction } from "./runtime"
import { cliproxyMode } from "./connection"
import { normalizeVersion } from "./release"

export function status(request: Request) { return managementRequest(request, false, async () => Response.json(await instanceStatus())) }
export function versions(request: Request) { return managementRequest(request, false, async () => {
  if (cliproxyMode() !== "managed") return jsonError("External releases are managed by your deployment.", 409)
  return Response.json(await (await managedService()).getVersions())
}) }

export function lifecycle(request: Request, params: { action: string }) {
  return managementRequest(request, true, async () => {
    const action = z.enum(["install", "start", "stop", "restart"]).safeParse(params.action)
    if (!action.success) return jsonError("Unknown CLIProxy action.", 404)
    if (cliproxyMode() !== "managed") return jsonError("Lifecycle controls require managed mode.", 409)
    let version: string | undefined
    if (action.data === "install") {
      const input = z.strictObject({ version: z.string() }).safeParse(await boundedObject(request).catch(() => null))
      if (!input.success) return jsonError("Provide a version to install.", 400)
      try { version = input.data.version === "latest" ? "latest" : normalizeVersion(input.data.version) }
      catch { return jsonError("Invalid release version.", 400) }
    } else if (request.body) {
      const reader = request.body.getReader()
      try { const { value } = await reader.read(); if (value?.length) { await reader.cancel(); return jsonError("This operation does not accept a body.", 400) } }
      finally { reader.releaseLock() }
    }
    const installed = await runInstanceAction(action.data, version)
    return Response.json({ ok: true, ...(installed ? { version: installed } : {}) })
  })
}
