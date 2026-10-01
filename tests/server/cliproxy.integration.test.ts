import { expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

test.skipIf(!process.env.CLIPROXY_INTEGRATION_BINARY)("real CLIProxy binary preserves private routing and settings across restart", async () => {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  reservation.stop(true)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rawroute-cliproxy-real-"))
  const child = Bun.spawn([process.execPath, "tests/server/cliproxy-real.fixture.ts"], {
    env: { ...process.env, NODE_ENV: "test", CLIPROXY_MODE: "managed", RAWROUTE_CLIPROXY_TEST_PORT: String(port), RAWROUTE_DATA_DIR: root, CLIPROXY_BUNDLED_BINARY: process.env.CLIPROXY_INTEGRATION_BINARY!, CLIPROXY_BUNDLED_VERSION: "7.3.4", CLIPROXY_LOCAL_MODELS: "true" },
    stdout: "pipe", stderr: "pipe",
  })
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain("Real CLIProxy integration passed")
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited }
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
