export type DashboardOwner = "platform" | "ai" | "tools" | "observability"
export type DashboardAppId = "ai-gateway" | "tool-gateway"
export type DashboardPageMeta = {
  path: string
  title: string
  scope: "workspace" | "global"
  owner: DashboardOwner
  app: DashboardAppId | "shared"
  skeleton: string
}

export function pagePathsFor<const T extends Record<string, DashboardPageMeta>>(pages: T) {
  return Object.fromEntries(Object.entries(pages).map(([id, page]) => [id, page.path])) as { [K in keyof T]: T[K]["path"] }
}

export const platformPages = {
  settings: { path: "/dashboard/settings", skeleton: "settings", title: "Settings", scope: "global", owner: "platform", app: "shared" },
} as const satisfies Record<string, DashboardPageMeta>

export const platformLoginPage = { id: "login", path: "/login", title: "Sign in", scope: "global", owner: "platform", app: "public", skeleton: "login" } as const
export const platformPagePaths = { home: "/", login: platformLoginPage.path, ...pagePathsFor(platformPages) } as const

export function matchesPagePath(pattern: string, pathname: string) {
  const expected = pattern.split("/")
  const actual = pathname.split("/")
  return expected.length === actual.length && expected.every((segment, index) => segment.startsWith(":") ? !!actual[index] : segment === actual[index])
}
