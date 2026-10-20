import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { DashboardRouteSkeleton, ShellCompositionProvider } from "../../packages/platform/src/web/shell-composition"
import { shellFixture } from "./shell-fixture"

test("platform route loading renders only the console-supplied contribution", () => {
  const markup = renderToStaticMarkup(<ShellCompositionProvider value={{ ...shellFixture, renderSkeleton: path => <p>Injected loading: {path}</p> }}><MemoryRouter initialEntries={["/any-owner/page"]}><DashboardRouteSkeleton /></MemoryRouter></ShellCompositionProvider>)
  expect(markup).toBe("<p>Injected loading: /any-owner/page</p>")
})

test("platform shell composition must be explicitly installed", () => {
  expect(() => renderToStaticMarkup(<MemoryRouter><DashboardRouteSkeleton /></MemoryRouter>)).toThrow("ShellCompositionProvider is required")
})
