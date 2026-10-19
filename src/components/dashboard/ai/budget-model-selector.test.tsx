import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { BudgetModelSelector } from "./budget-model-selector"

test("renders removed selections so they can be individually removed", () => {
  const markup = renderToStaticMarkup(<BudgetModelSelector title="Excluded models" description="Choose models" modelIds={["removed"]} modelOptions={[]} pending={false} onChange={() => {}} />)
  expect(markup).toContain("removed")
  expect(markup).toContain("Unavailable")
  expect(markup).toContain("Model or routing entry removed")
  expect(markup).not.toContain("No enabled models available")
  expect(markup).not.toContain("disabled=\"\"")
})

test("shows combo members and keeps unavailable unselected options out of the list", () => {
  const markup = renderToStaticMarkup(<BudgetModelSelector title="Allowed models" description="Choose models" modelIds={[]} modelOptions={[
    { id: "combo", name: "Coding", provider: "Combo", kind: "combo", available: true, members: ["p/expensive", "p/cheap"] },
    { id: "disabled", name: "Disabled model", provider: "Provider", kind: "model", available: false, members: [] },
  ]} pending={false} onChange={() => {}} />)
  expect(markup).toContain("p/expensive → p/cheap")
  expect(markup).not.toContain("Disabled model")
})
