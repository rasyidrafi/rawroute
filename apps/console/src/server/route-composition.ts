import { validateServerRoutes, type ServerRouteContribution } from "@rawroute/platform/contracts/http"
import { apiRoute } from "@rawroute/platform/server/http"

/** Explicit console composition; domain declarations contain no Bun server singleton. */
export function composeServerRoutes(contributions: readonly ServerRouteContribution[]) {
  validateServerRoutes(contributions)
  return Object.fromEntries(contributions.flatMap(contribution => contribution.routes.map(route => [
    route.path, apiRoute(route.handlers, route.access, route.path, route.options),
  ])))
}
