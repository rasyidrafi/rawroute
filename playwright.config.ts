import { accessSync, constants, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { defineConfig, devices } from "@playwright/test"

function isExecutableFile(path: string) {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function findGoogleChrome() {
  const configuredPath = process.env.PLAYWRIGHT_CHROME_EXECUTABLE_PATH
  if (configuredPath) {
    if (isExecutableFile(configuredPath)) return configuredPath
    throw new Error("PLAYWRIGHT_CHROME_EXECUTABLE_PATH must point to an existing Google Chrome executable.")
  }

  const executableNames = process.platform === "win32" ? ["chrome.exe"] : ["google-chrome-stable", "google-chrome"]
  const pathCandidates = (process.env.PATH ?? "").split(delimiter).flatMap(directory => executableNames.map(name => join(directory, name)))
  const standardLocations = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
    : process.platform === "win32"
      ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter((root): root is string => Boolean(root)).map(root => join(root, "Google", "Chrome", "Application", "chrome.exe"))
      : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/opt/google/chrome/chrome"]
  const executable = [...pathCandidates, ...standardLocations].find(isExecutableFile)
  if (!executable) {
    throw new Error("Google Chrome was not found. Set PLAYWRIGHT_CHROME_EXECUTABLE_PATH to an existing Chrome executable; bundled Playwright Chromium is disabled.")
  }
  return executable
}

const chromeExecutablePath = findGoogleChrome()

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: chromeExecutablePath } } }],
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
        RAWROUTE_PUBLIC_URL: "http://127.0.0.1:3100",
        HOSTNAME: "127.0.0.1",
        SESSION_SECRET: "rawroute-browser-tests-session-secret",
        EXECUTOR_UPSTREAM_URL: "http://127.0.0.1:3211/executor",
        EXECUTOR_UPSTREAM_API_KEY: "executor-test-key",
        CLIPROXY_MODE: "external",
        CLIPROXY_API_KEY: "sk-e2e-internal",
        CLIPROXY_MANAGEMENT_KEY: "e2e-management-key",
        STORAGE_BACKEND: "sqlite",
        SQLITE_PATH: ":memory:",
        DEFAULT_ADMIN_PASSWORD: "e2e-initial-password",
        DEFAULT_PROXY_API_KEY: "sk-e2e-gateway",
        CODEX_BASE_URL: "http://127.0.0.1:3211/codex",
        CLIPROXY_URL: "http://127.0.0.1:3211/cliproxy",
      },
    },
  ],
})
