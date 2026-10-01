import { expect, test } from "bun:test"
import { convertDocument } from "../../scripts/migrations/current-data"

test("offline conversion preserves combo ordering, policies, model identity and password hash", () => {
  const combo = { path: "rawroute_workspaces/default/combos/c", data: { combo: "fallback", memberModelIds: ["p/b", "p/a"] } }
  const converted = convertDocument(combo, [])
  expect(converted.data).toEqual({ combo: "fallback", members: [{ modelId: "p/b", reasoning: { mode: "inherit" } }, { modelId: "p/a", reasoning: { mode: "inherit" } }] })
  expect(convertDocument(converted, [])).toEqual(converted)
  expect(combo.data.memberModelIds).toEqual(["p/b", "p/a"])
  expect(convertDocument({ path: "rawroute_system/meta", data: { admin: { username: "admin", passwordHash: "private-hash", mustChangePassword: false } } }, []).data).toEqual({ admin: { passwordHash: "private-hash", mustChangePassword: false } })
  expect(convertDocument({ path: "rawroute_workspaces/default/providers/p/models/m", data: { source: "builtin", gatewayModelId: "p/model", enabled: false } }, []).data).toMatchObject({ source: "discovered", gatewayModelId: "p/model", enabled: false, discovery: { stale: true } })
  const modern = { path: combo.path, data: { members: [{ modelId: "p/a", reasoning: { mode: "override", effort: "high" } }], memberModelIds: ["p/b"] } }
  expect(convertDocument(modern, []).data.members).toEqual(modern.data.members)
})

test("Codex conversion requires a known auth file and removes token material only after mapping", () => {
  const doc = { path: "rawroute_workspaces/default/providers/p/apiKeys/a", data: { credentialKind: "codex-oauth", cliProxyAuthFile: "account.json", key: "encrypted-token", refreshToken: "encrypted-refresh", idToken: "encrypted-id", rpmLimit: 10 } }
  expect(() => convertDocument(doc, [])).toThrow("Unmapped Codex account")
  expect(convertDocument(doc, [{ name: "account.json", disabled: false, authIndex: "index" }]).data).toEqual({ credentialKind: "codex-cli-proxy", cliProxyAuthFile: "account.json", cliProxyAuthIndex: "index", key: "", enabled: true })
  expect(doc.data.key).toBe("encrypted-token")
})
