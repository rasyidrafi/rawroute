import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { WrenchIcon } from "lucide-react"
import { MemoryRouter } from "react-router"
import { IntegrationsView } from "../../packages/gateway-ai/src/web/components/integrations-view"
import { IntegrationDetailView } from "../../packages/gateway-ai/src/web/components/integrations/detail-view"
import { integrationSnippets } from "../../packages/gateway-ai/src/web/components/integrations/catalog"
import { dashboardApps } from "../../apps/console/src/frontend/browser-modules"
import { dashboardPageForPath, dashboardPages, pagePaths } from "../../apps/console/src/frontend/contracts/dashboard/routes"
import { ShellFixture } from "./shell-fixture"

test("integrations follows model routing and uses the wrench icon", () => {
  const items = dashboardApps.find(app => app.id === "ai-gateway")?.navigation.find(group => group.label === "Gateway")?.items
  const routingIndex = items?.findIndex(item => item.href === pagePaths.aliases) ?? -1
  expect(routingIndex).toBeGreaterThanOrEqual(0)
  expect(items?.[routingIndex + 1]).toEqual({ page: "integrations", title: "Integrations", icon: WrenchIcon, href: pagePaths.integrations })
  expect(dashboardPageForPath(pagePaths.integrations)).toBe("integrations")
  expect(dashboardPages.integrations.scope).toBe("workspace")
})

test("integrations links to scoped guides and describes the connection", () => {
  const markup = renderToStaticMarkup(<ShellFixture><MemoryRouter><IntegrationsView /></MemoryRouter></ShellFixture>)
  expect(markup).toContain(`href="${pagePaths.integrationOpencode}"`)
  expect(markup).toContain(`href="${pagePaths.integrationCodex}"`)
  expect(markup).toContain("Connect your coding agents to RawRoute.")
  for (const page of ["integrationOpencode", "integrationCodex"] as const) {
    expect(dashboardPageForPath(pagePaths[page])).toBe(page)
    expect(dashboardPages[page].scope).toBe("workspace")
  }
})

test("guide previews include configuration, placeholder credentials, and return navigation", () => {
  for (const integration of ["opencode", "codex"] as const) {
    const markup = renderToStaticMarkup(<ShellFixture><MemoryRouter><IntegrationDetailView integration={integration} /></MemoryRouter></ShellFixture>)
    expect(markup).toContain(`href="${pagePaths.integrations}"`)
    expect(markup).toContain(integration === "opencode" ? "YOUR_MODEL_ID" : "gpt-6-luna")
    expect(markup).toContain(integration === "opencode" ? "YOUR_WORKSPACE_API_KEY" : "PUT_TOKEN_HERE")
    expect(markup).toContain("https://your-rawroute-host/v1")
    expect(markup).toContain(integration === "opencode" ? "opencode.json" : "config.toml")
  }
})

test("Codex configuration preserves the existing settings with the current gateway URL", () => {
  const snippets = integrationSnippets("codex", "https://gateway.example/v1")
  expect(snippets).toHaveLength(1)
  expect(snippets[0]?.code).toBe(`model_provider = "rawroute"
model = "gpt-6-luna"
model_reasoning_effort = "xhigh"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.rawroute]
name = "Rawroute"
base_url = "https://gateway.example/v1"
wire_api = "responses"
experimental_bearer_token="PUT_TOKEN_HERE"

[agents]
enabled = false`)
})
