import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { groupModelOptions, ModelPicker } from "../../src/web/components/model-picker"

const options = [
  { id: "team-b/gpt-6.2-sol", name: "Sol", provider: "Team B" },
  { id: "gpt-6.2-sol", name: "Sol", provider: "OpenAI" },
  { id: "gpt-6-astra", name: "Astra", provider: "OpenAI" },
  { id: "removed/model", name: "removed/model", provider: null },
  { id: "", name: "All models" },
]

test("picker groups sort providers alphabetically with unattributed IDs last and names sorted inside", () => {
  expect(groupModelOptions(options).map(group => [group.provider, group.models.map(model => model.id)])).toEqual([
    ["OpenAI", ["gpt-6-astra", "gpt-6.2-sol"]],
    ["Team B", ["team-b/gpt-6.2-sol"]],
    ["Other models", ["removed/model"]],
  ])
})

test("picker trigger keeps the selected name with its provider and falls back to the raw ID", () => {
  const selected = renderToStaticMarkup(<ModelPicker label="Model" value="gpt-6.2-sol" options={options} onChange={() => {}} />)
  expect(selected).toContain("Sol")
  expect(selected).toContain("OpenAI")
  const historical = renderToStaticMarkup(<ModelPicker label="Model" value="gone/id" options={options} onChange={() => {}} />)
  expect(historical).toContain("gone/id")
  const all = renderToStaticMarkup(<ModelPicker label="Model" value="" options={options} onChange={() => {}} />)
  expect(all).toContain("All models")
})