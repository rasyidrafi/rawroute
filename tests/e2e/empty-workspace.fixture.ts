import { expect, test as base } from "@playwright/test"

// Real API emptiness checks must not depend on traffic from earlier browser tests.
export const test = base.extend<{ emptyWorkspaceId: string }>({
  emptyWorkspaceId: async ({ page }, provide) => {
    let login = await page.request.post("/api/auth/login", { data: { password: "e2e-initial-password" } })
    if (!login.ok()) login = await page.request.post("/api/auth/login", { data: { password: "private-password" } })
    expect(login.ok()).toBe(true)
    if ((await (await page.request.get("/api/admin/account")).json()).mustChangePassword) {
      expect((await page.request.post("/api/admin/account/password", { data: { password: "private-password" } })).ok()).toBe(true)
    }
    const name = `Empty API fixture ${crypto.randomUUID()}`
    const created = await page.request.post("/api/admin/workspaces", { data: { name } })
    expect(created.ok()).toBe(true)
    const { workspace } = await created.json() as { workspace: { id: string } }
    try {
      await provide(workspace.id)
    } finally {
      const deleted = await page.request.delete(`/api/admin/workspaces/${workspace.id}`, {
        data: { confirmation: name }, headers: { "x-rawroute-workspace-id": "default" },
      })
      expect(deleted.ok()).toBe(true)
    }
  },
})
