import { CLIPROXY_PORT, getDataRoot, getServicePaths, readSecret } from "./store"

export function cliproxyMode(): "managed" | "external" {
  const mode = process.env.CLIPROXY_MODE
  if (mode && mode !== "managed" && mode !== "external") throw new Error("CLIPROXY_MODE must be managed or external.")
  if (mode === "managed" || mode === "external") return mode
  return process.env.CLIPROXY_URL || process.env.CLIPROXY_MANAGEMENT_KEY || process.env.CLIPROXY_API_KEY ? "external" : "managed"
}

export function cliproxyBaseUrl() {
  return cliproxyMode() === "managed" ? `http://127.0.0.1:${CLIPROXY_PORT}` : (process.env.CLIPROXY_URL || "http://cli-proxy-api:8317").replace(/\/$/, "")
}

export function cliproxySecret(kind: "apiKey" | "managementKey") {
  if (cliproxyMode() === "managed") return readSecret(getServicePaths(getDataRoot())[kind])
  return process.env[kind === "apiKey" ? "CLIPROXY_API_KEY" : "CLIPROXY_MANAGEMENT_KEY"]?.trim() || ""
}

export function hasManagementCredential() {
  try { return Boolean(cliproxySecret("managementKey")) } catch { return false }
}
