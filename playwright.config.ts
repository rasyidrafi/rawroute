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
      command: "npx tsx tests/e2e/codex-auth-mock.ts",
      url: "http://127.0.0.1:3211/health",
      reuseExistingServer: false,
    },
    {
      command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
      url: "http://127.0.0.1:3100/login",
      reuseExistingServer: false,
      env: {
        STORAGE_BACKEND: "memory",
        DEFAULT_ADMIN_PASSWORD: "change-me-now",
        DEFAULT_PROXY_API_KEY: "sk-local-change-me",
        CODEX_AUTH_BASE_URL: "http://127.0.0.1:3211",
        CODEX_BASE_URL: "http://127.0.0.1:3211/codex",
      },
    },
  ],
})
