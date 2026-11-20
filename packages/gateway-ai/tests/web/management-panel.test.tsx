import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Panel } from "../../src/web/components/management-panel"

function render(refreshing?: boolean) {
  return renderToStaticMarkup(<Panel title="Model pricing" description="Group compatible models." icon={<span aria-hidden="true" />} refreshing={refreshing}>Retained content</Panel>)
}

test("panel keeps its content under the shared refreshing overlay", () => {
  const markup = render(true)
  expect(markup).toContain("Retained content")
  expect(markup).toContain("Refreshing data...")
  expect(markup).toContain('aria-busy="true"')
})

test("panel renders no overlay when it is not refreshing", () => {
  const markup = render(false)
  expect(markup).toContain("Retained content")
  expect(markup).not.toContain("Refreshing data...")
})