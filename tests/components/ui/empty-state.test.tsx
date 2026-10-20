import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ArrowRightIcon } from "lucide-react"

import { EmptyState } from "../../../packages/ui/src/empty-state"

test("default empty state is a semantic bordered card with icon, title, description, and action", () => {
  const markup = renderToStaticMarkup(<EmptyState title="Nothing here" description="Add an item to get started." icon={ArrowRightIcon} action={<button type="button">Add item</button>} />)

  expect(markup).toContain('data-slot="empty-state"')
  expect(markup).toContain('data-treatment="card"')
  expect(markup).toContain('role="status"')
  expect(markup).toContain('aria-live="polite"')
  expect(markup).toContain("rounded-xl border")
  expect(markup).toContain('data-slot="empty-icon"')
  expect(markup).toContain('aria-hidden="true"')
  expect(markup).toContain("<h3")
  expect(markup).toContain("Nothing here")
  expect(markup).toContain("<p")
  expect(markup).toContain("Add an item to get started.")
  expect(markup).toContain("Add item")
})

test("compact embedded empty state has no outer card border and keeps its status semantics", () => {
  const markup = renderToStaticMarkup(<EmptyState title="No matches" description="Try another search." variant="compact" treatment="embedded" />)

  expect(markup).toContain('data-variant="compact"')
  expect(markup).toContain('data-treatment="embedded"')
  expect(markup).toContain('role="status"')
  expect(markup).toContain("rounded-full")
  expect(markup).toContain("No matches")
  expect(markup).toContain("Try another search.")
  expect(markup).not.toContain("rounded-xl border border-border")
})
