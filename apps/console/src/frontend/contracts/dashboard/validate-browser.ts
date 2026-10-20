import type { BrowserModule } from "@rawroute/platform/web/browser-module"
import { platformLoginPage } from "@rawroute/platform/contracts/dashboard"
import { validatePageContributions, validatePageReferences } from "./validate"

export function validateBrowserModules(modules: readonly BrowserModule[]) {
  validatePageContributions(modules)
  const owners = new Set<string>()
  const apps = new Set<string>()
  const paths = new Set([platformLoginPage.path, ...modules.flatMap(module => Object.values(module.pages).map(page => page.path.replace(/:[^/]+/g, ":parameter")))])
  const ids = new Set([platformLoginPage.id, ...modules.flatMap(module => Object.keys(module.pages))])
  for (const module of modules) {
    if (owners.has(module.owner)) throw new Error(`Duplicate browser module owner: ${module.owner}`)
    owners.add(module.owner)
    if (Object.values(module.pages).some(page => page.app !== "shared") && !module.app) throw new Error(`Browser module ${module.owner} requires its app contribution`)
    for (const route of module.publicRoutes ?? []) {
      if (route.owner !== module.owner) throw new Error(`Public page ${route.id} owner does not match ${module.owner}`)
      if (ids.has(route.id)) throw new Error(`Duplicate public page ID: ${route.id}`)
      ids.add(route.id)
      const path = route.path.replace(/:[^/]+/g, ":parameter")
      if (paths.has(path)) throw new Error(`Duplicate public page path: ${route.path}`)
      paths.add(path)
      if (!route.view || !route.skeleton || !route.title || route.app !== "public" || !route.path.startsWith("/") || /[?#*]/.test(route.path) || route.path.includes("//") || (route.path !== "/" && route.path.endsWith("/")) || !["global", "workspace"].includes(route.scope)) throw new Error(`Invalid public page contribution: ${route.id}`)
    }
    const navigation = [...(module.app?.navigation.flatMap(group => group.items) ?? []), ...(module.sharedNavigation?.workspace ?? []), ...(module.sharedNavigation?.global ?? [])]
    validatePageReferences(module.pages, module.views, navigation)
    validatePageReferences(module.pages, module.skeletons, [])
    for (const item of navigation) {
      const page = module.pages[item.page]!
      if (item.href !== page.path || item.title !== page.title) throw new Error(`Navigation metadata mismatch for ${module.owner} page ${item.page}`)
    }
    for (const item of [...(module.sharedNavigation?.workspace ?? []), ...(module.sharedNavigation?.global ?? [])]) {
      if (module.pages[item.page]!.app !== "shared") throw new Error(`Shared navigation references app-specific page ${item.page}`)
    }
    if (module.app) {
      if (apps.has(module.app.id)) throw new Error(`Duplicate dashboard app ID: ${module.app.id}`)
      apps.add(module.app.id)
      if (!Object.values(module.pages).some(page => page.path === module.app!.href && page.app === module.app!.id)) throw new Error(`App ${module.app.id} has no owned landing page`)
      for (const item of module.app.navigation.flatMap(group => group.items)) {
        if (module.pages[item.page]!.app !== module.app.id) throw new Error(`App navigation references unowned placement: ${item.page}`)
      }
    }
  }
}
