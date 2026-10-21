import type { DashboardOwner, DashboardPageMeta } from "@rawroute/platform/contracts/dashboard"

export type PageContribution = {
  owner: DashboardOwner
  pages: Readonly<Record<string, DashboardPageMeta>>
}

/** Validate before merging objects: a spread must never silently replace a page. */
export function validatePageContributions(contributions: readonly PageContribution[]) {
  const ids = new Set<string>()
  const paths = new Map<string, string>()
  for (const contribution of contributions) {
    for (const [id, page] of Object.entries(contribution.pages)) {
      if (ids.has(id)) throw new Error(`Duplicate dashboard page ID: ${id}`)
      ids.add(id)
      if (page.owner !== contribution.owner) throw new Error(`Dashboard page ${id} owner ${page.owner} does not match contribution ${contribution.owner}`)
      if (!page.path.startsWith("/dashboard/") || page.path.endsWith("/") || /[?#*]/.test(page.path) || page.path.includes("//")) throw new Error(`Invalid canonical dashboard path for ${id}: ${page.path}`)
      const equivalent = page.path.replace(/:[^/]+/g, ":parameter")
      const existing = paths.get(equivalent)
      if (existing) throw new Error(`Duplicate or parameter-equivalent dashboard paths: ${existing} and ${id} (${page.path})`)
      paths.set(equivalent, id)
      if (!page.title || !page.skeleton) throw new Error(`Dashboard page ${id} requires title and skeleton`)
      if (page.scope !== "workspace" && page.scope !== "global") throw new Error(`Invalid dashboard scope for ${id}`)
      const app = contribution.owner === "ai" ? "ai-gateway" : contribution.owner === "tools" ? "tool-gateway" : contribution.owner === "storage" ? "storage-gateway" : "shared"
      if (page.app !== app && !(contribution.owner === "ai" && page.app === "shared")) throw new Error(`Invalid app placement for ${contribution.owner} page ${id}: ${page.app}`)
      if (contribution.owner === "tools" && page.scope !== "global") throw new Error(`Tools page ${id} must have global scope`)
      if (page.app !== "shared" && !page.path.startsWith(`/dashboard/${contribution.owner}/`)) throw new Error(`Dashboard page ${id} path does not match its app`)
    }
  }
}

export function validatePageReferences(pages: Readonly<Record<string, DashboardPageMeta>>, views: Readonly<Record<string, unknown>>, navigation: readonly { page: string }[]) {
  for (const id of Object.keys(pages)) {
    if (!Object.hasOwn(views, id) || views[id] == null) throw new Error(`Missing dashboard view for page ${id}`)
  }
  for (const id of Object.keys(views)) {
    if (!Object.hasOwn(pages, id)) throw new Error(`Dashboard view references unknown page ${id}`)
  }
  for (const item of navigation) {
    if (!Object.hasOwn(pages, item.page)) throw new Error(`Dashboard navigation references unknown page ${item.page}`)
  }
}
