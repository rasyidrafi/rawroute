import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "bun tests/e2e/codex-auth-mock.ts",
      url: "http://127.0.0.1:3211/health",
      reuseExistingServer: false,
    },
    {
      command: "bun run start",
      url: "http://127.0.0.1:3100/login",
      reuseExistingServer: false,
      env: {
        PORT: "3100",
        HOSTNAME: "127.0.0.1",
        SESSION_SECRET: "rawroute-browser-tests-session-secret",
        CREDENTIAL_ENCRYPTION_KEY: "rawroute-browser-tests-encryption-key",
        REDIS_URL: process.env.E2E_REDIS_URL || "redis://127.0.0.1:6379/15",
        EXECUTOR_UPSTREAM_URL: "http://127.0.0.1:3211/executor",
        EXECUTOR_UPSTREAM_API_KEY: "executor-test-key",
        CLIPROXY_API_KEY: "sk-e2e-internal",
        CLIPROXY_MANAGEMENT_KEY: "e2e-management-key",
        STORAGE_BACKEND: "memory",
        DEFAULT_ADMIN_PASSWORD: "e2e-initial-password",
        DEFAULT_PROXY_API_KEY: "sk-e2e-gateway",
        CODEX_AUTH_BASE_URL: "http://127.0.0.1:3211",
        CODEX_BASE_URL: "http://127.0.0.1:3211/codex",
        CLIPROXY_URL: "http://127.0.0.1:3211/cliproxy",
      },
    },
  ],
})
