import { DEFAULT_ADMIN_PASSWORD } from "../src/lib/auth-defaults"
import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"

const directory = resolve(process.argv[2] || ".rawroute")
const names = ["app.env", "cliproxy.env", "cliproxy.yaml", "executor.env"]
if (names.some(name => existsSync(join(directory, name)))) {
  throw new Error("Configuration already exists. Refusing to replace credentials.")
}
mkdirSync(directory, { recursive: true, mode: 0o700 })
const secret = () => randomBytes(32).toString("hex")
const managementKey = secret()
const apiKey = secret()
const executorAdminPassword = secret()
const files: Record<string, string> = {
  "app.env": `STORAGE_BACKEND=sqlite
DEFAULT_ADMIN_PASSWORD=${DEFAULT_ADMIN_PASSWORD}
DEFAULT_PROXY_API_KEY=sk-${secret()}
SESSION_SECRET=${secret()}
TIMEZONE=UTC
SQLITE_PATH=/data/rawroute.sqlite
DATABASE_CHILD_READ_CONCURRENCY=2
MAX_WORKSPACE_CACHE_ENTRIES=32
MAX_PROVIDER_SCOPED_CACHE_ENTRIES=32
RAWROUTE_PUBLIC_URL=http://localhost:8080
CLIPROXY_URL=http://cli-proxy-api:8317
CLIPROXY_MANAGEMENT_KEY=${managementKey}
CLIPROXY_API_KEY=${apiKey}
EXECUTOR_UPSTREAM_URL=http://executor:4788
EXECUTOR_UPSTREAM_API_KEY=
`,
  "cliproxy.env": `MANAGEMENT_PASSWORD=${managementKey}
`,
  "executor.env": `EXECUTOR_HOST=0.0.0.0
EXECUTOR_DATA_DIR=/data
EXECUTOR_BOOTSTRAP_ADMIN_EMAIL=executor-admin@example.invalid
EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD=${executorAdminPassword}
EXECUTOR_BOOTSTRAP_ADMIN_NAME=RawRoute Executor Admin
EXECUTOR_ALLOW_LOCAL_NETWORK=false
EXECUTOR_ALLOW_STDIO_MCP=false
`,
  "cliproxy.yaml": `host: ""
port: 8317
remote-management:
  allow-remote: true
  secret-key: ""
  disable-control-panel: true
  disable-auto-update-panel: true
auth-dir: "~/.cli-proxy-api"
api-keys:
  - "${apiKey}"
debug: false
logging-to-file: false
usage-statistics-enabled: true
request-retry: 0
max-retry-credentials: 0
max-retry-interval: 0
disable-cooling: true
transient-error-cooldown-seconds: -1
plugins:
  enabled: false
routing:
  strategy: "fill-first"
`,
}
for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(directory, name), content, { mode: 0o600, flag: "wx" })
}
console.log(`Created private configuration in ${directory}. Credentials were not printed.`)
