export const browserEvents = {
  "dashboard.navigation": "Dashboard page opened",
  "dashboard.copy": "Clipboard copy completed",
  "dashboard.copy-failed": "Clipboard copy failed",
  "dashboard.error": "Dashboard runtime error (details omitted)",
  "dashboard.rejection": "Dashboard unhandled rejection (details omitted)",
  "logs.copied": "Log entries copied",
  "logs.paused": "Live log updates paused",
  "logs.resumed": "Live log updates resumed",
} as const
export type BrowserEvent = keyof typeof browserEvents

