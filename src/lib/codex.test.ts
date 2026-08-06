import { describe, expect, test } from "vitest"

import {
  buildCodexAuthorizationUrl,
  codexDeviceRedirectUri,
  ensureCodexProvider,
  generatePkce,
  listCodexAccounts,
  pollCodexDeviceCode,
  refreshCodexToken,
  requestCodexDeviceCode,
  saveCodexAccount,
} from "@/lib/codex"
import { _resetMemoryBackend, listProviders, readData } from "@/lib/store"
import { runInWorkspace } from "@/lib/workspace-context"
import { createWorkspace, listWorkspaces, resetWorkspacesForTests } from "@/lib/workspaces"

describe("Codex OAuth", () => {
  test("generates standards-compliant PKCE authorization parameters", () => {
    const pkce = generatePkce()
    const url = new URL(buildCodexAuthorizationUrl("state-1", pkce.challenge))
    expect(url.origin).toBe("https://auth.openai.com")
    expect(url.pathname).toBe("/oauth/authorize")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge)
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")
    expect(url.searchParams.get("scope")).toContain("offline_access")
  })

  test("requests and polls the official device-code endpoints", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    let poll = 0
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>
      calls.push({ url, body })
      if (url.endsWith("/usercode")) return new Response(JSON.stringify({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: "3" }), { status: 200 })
      poll += 1
      return poll === 1 ? new Response("pending", { status: 403 }) : new Response(JSON.stringify({ authorization_code: "auth-code", code_verifier: "verifier" }), { status: 200 })
    }) as unknown as typeof fetch

    const device = await requestCodexDeviceCode(fetchImpl)
    expect(device).toMatchObject({ deviceAuthId: "device-1", userCode: "ABCD-EFGH", intervalSeconds: 3, verificationUrl: "https://auth.openai.com/codex/device" })
    expect((await pollCodexDeviceCode(device.deviceAuthId, device.userCode, fetchImpl)).status).toBe("pending")
    expect(await pollCodexDeviceCode(device.deviceAuthId, device.userCode, fetchImpl)).toEqual({ status: "authorized", code: "auth-code", verifier: "verifier" })
    expect(calls[0]).toMatchObject({ url: "https://auth.openai.com/api/accounts/deviceauth/usercode", body: { client_id: "app_EMoamEEZ73f0CkXaXp7hrann" } })
    expect(calls[1].body).toEqual({ device_auth_id: "device-1", user_code: "ABCD-EFGH" })
  })

  test("preserves a rotated refresh token and account metadata", async () => {
    const idToken = `header.${Buffer.from(JSON.stringify({ email: "codex@example.com", exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "pro" } })).toString("base64url")}.signature`
    const fetchImpl = (async () => new Response(JSON.stringify({ access_token: "new-access", id_token: idToken, expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch
    const result = await refreshCodexToken("old-refresh", { id: "a", providerId: "p", name: "A", key: "old-access", refreshToken: "old-refresh", email: "old@example.com", enabled: true, createdAt: "now" }, fetchImpl)
    expect(result).toMatchObject({ accessToken: "new-access", refreshToken: "old-refresh", accountId: "acct-1", email: "codex@example.com", planType: "pro" })
  })

  test("creates the dedicated Codex Responses provider and account", async () => {
    process.env.STORAGE_BACKEND = "memory"
    process.env.CREDENTIAL_ENCRYPTION_KEY = "test-encryption-key"
    _resetMemoryBackend()
    const { provider, account } = await saveCodexAccount({ accessToken: "access", refreshToken: "refresh", accountId: "acct-2", email: "two@example.com", expiresAt: new Date(Date.now() + 3600000).toISOString() })
    expect(provider).toMatchObject({ prefix: "codex", protocol: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" })
    expect(account).toMatchObject({ credentialKind: "codex-oauth", accountId: "acct-2", email: "two@example.com" })
    expect((await readData()).providerApiKeys[0]?.key).toBe("access")
    _resetMemoryBackend()
  })

  test("keeps the dedicated Codex provider isolated per workspace", async () => {
    process.env.STORAGE_BACKEND = "memory"
    _resetMemoryBackend()
    await resetWorkspacesForTests()
    const defaultWorkspace = (await listWorkspaces()).find((workspace) => workspace.isDefault)!
    const alternateWorkspace = await createWorkspace("Alternate")

    const defaultProvider = await runInWorkspace(defaultWorkspace, () => ensureCodexProvider())
    const alternateProvider = await runInWorkspace(alternateWorkspace, () => ensureCodexProvider())

    expect(alternateProvider.id).not.toBe(defaultProvider.id)
    expect((await runInWorkspace(defaultWorkspace, () => listProviders())).map((provider) => provider.id)).toEqual([defaultProvider.id])
    expect((await runInWorkspace(alternateWorkspace, () => listProviders())).map((provider) => provider.id)).toEqual([alternateProvider.id])
    expect((await runInWorkspace(alternateWorkspace, () => listCodexAccounts())).provider?.id).toBe(alternateProvider.id)
    _resetMemoryBackend()
  })

  test("uses the auth issuer device callback for code exchange", () => {
    expect(codexDeviceRedirectUri()).toBe("https://auth.openai.com/deviceauth/callback")
  })
})
