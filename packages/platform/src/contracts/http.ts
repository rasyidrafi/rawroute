export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"
export type RouteAccess = "public" | "session" | "workspace" | "explicit-workspace" | "gateway"

/** Concrete transport policy, declared by the route owner rather than inferred from URLs. */
export type RouteOptions = {
  idleTimeout?: 0
  idleTimeoutMethods?: readonly HttpMethod[]
  allowInitialPassword?: true
  operationalLog?: "omit"
}

export type RouteHandler<Params = Record<string, string>> = (request: Request, params: Params) => Response | Promise<Response>

export type ServerRouteDeclaration = {
  path: string
  access: RouteAccess
  handlers: Partial<Record<HttpMethod, RouteHandler>>
  options?: RouteOptions
}

export type ServerRouteContribution = {
  id: string
  routes: readonly ServerRouteDeclaration[]
}

export function declareRoute<Params extends Record<string, string>>(
  handlers: Partial<Record<HttpMethod, RouteHandler<Params>>>,
  access: RouteAccess,
  path: string,
  options?: RouteOptions,
): ServerRouteDeclaration {
  // Bun extracts the named parameters from this declaration's template. The
  // erased shape allows independently typed handlers in one static contribution.
  return { path, access, handlers: handlers as Partial<Record<HttpMethod, RouteHandler>>, options }
}

const methods = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
const accessPolicies = new Set<RouteAccess>(["public", "session", "workspace", "explicit-workspace", "gateway"])

/** Validate the actual declarations before passing them to Bun's native router. */
export function validateServerRoutes(contributions: readonly ServerRouteContribution[]) {
  const ids = new Set<string>()
  const templates = new Set<string>()
  for (const contribution of contributions) {
    if (!contribution.id || ids.has(contribution.id)) throw new Error(`Duplicate or empty route contribution: ${contribution.id}`)
    ids.add(contribution.id)
    for (const route of contribution.routes) {
      if (!route.path.startsWith("/") || route.path.includes("?") || route.path.includes("#") || route.path.includes("//")) throw new Error(`Invalid route path: ${route.path}`)
      if (!accessPolicies.has(route.access)) throw new Error(`Missing or invalid access policy: ${route.path}`)
      const segments = route.path.slice(1).split("/")
      const params = new Set<string>()
      for (const [index, segment] of segments.entries()) {
        if (segment.includes("*") && (segment !== "*" || index !== segments.length - 1)) throw new Error(`Invalid wildcard template: ${route.path}`)
        if (segment.includes(":")) {
          if (!/^:[a-zA-Z][a-zA-Z0-9_]*$/.test(segment) || params.has(segment)) throw new Error(`Invalid parameter template: ${route.path}`)
          params.add(segment)
        }
      }
      const template = segments.map(segment => segment.startsWith(":") ? ":" : segment).join("/")
      // Bun registers one handler per path, including its 405/OPTIONS behavior.
      // Splitting methods across contributions would silently shadow a handler.
      if (templates.has(template)) throw new Error(`Duplicate route template: ${route.path}`)
      templates.add(template)
      const entries = Object.entries(route.handlers)
      if (!entries.length || entries.some(([method, handler]) => !methods.has(method as HttpMethod) || typeof handler !== "function")) throw new Error(`Invalid route methods: ${route.path}`)
      if (route.options?.allowInitialPassword && route.access !== "session") throw new Error(`Initial-password exception requires session access: ${route.path}`)
      if (route.options?.idleTimeout !== undefined && route.options.idleTimeout !== 0) throw new Error(`Invalid idle timeout: ${route.path}`)
      if (route.options?.idleTimeoutMethods && (route.options.idleTimeout !== 0 || !route.options.idleTimeoutMethods.length || route.options.idleTimeoutMethods.some(method => !Object.hasOwn(route.handlers, method)))) throw new Error(`Invalid idle timeout methods: ${route.path}`)
    }
  }
}
