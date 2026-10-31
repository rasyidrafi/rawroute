import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"

const directory = resolve(process.argv[2] || ".rawroute")
const names = ["app.env", "executor.env"]
if (names.some(name => existsSync(join(directory, name)))) {
  throw new Error("Configuration already exists. Refusing to replace credentials.")
}
mkdirSync(directory, { recursive: true, mode: 0o700 })
const secret = () => randomBytes(32).toString("hex")
const executorAdminPassword = secret()
const files: Record<string, string> = {
  "app.env": `SQLITE_PATH=/data/rawroute.sqlite
RAWROUTE_DATA_DIR=/data
EXECUTOR_UPSTREAM_URL=http://executor:4788
EXECUTOR_UPSTREAM_API_KEY=
`,
  "executor.env": `EXECUTOR_HOST=0.0.0.0
EXECUTOR_DATA_DIR=/data
EXECUTOR_BOOTSTRAP_ADMIN_EMAIL=executor-admin@example.invalid
EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD=${executorAdminPassword}
EXECUTOR_BOOTSTRAP_ADMIN_NAME=RawRoute Executor Admin
EXECUTOR_ALLOW_LOCAL_NETWORK=false
EXECUTOR_ALLOW_STDIO_MCP=false
`,
}
for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(directory, name), content, { mode: 0o600, flag: "wx" })
}
console.log(`Created private configuration in ${directory}. Credentials were not printed.`)
