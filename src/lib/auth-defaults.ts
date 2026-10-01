export const DEFAULT_ADMIN_PASSWORD = "change-me-now"

export function isLocalLoginHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
}

export type BootstrapStatus = { isDefaultPassword: boolean; defaultPasswordHint: string | null }
