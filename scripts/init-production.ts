import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"

const directory = resolve(process.argv[2] || ".rawroute")
const names = ["app.env", "postgres.env", "cliproxy.env", "cliproxy.yaml"]
if (names.some(name => existsSync(join(directory, name)))) {
  throw new Error("Configuration already exists. Refusing to replace credentials.")
}
mkdirSync(directory, { recursive: true, mode: 0o700 })
const secret = () => randomBytes(32).toString("hex")
const databasePassword = secret()
const managementKey = secret()
const apiKey = secret()
const files: Record<string, string> = {
  "app.env": `STORAGE_BACKEND=postgres
DEFAULT_ADMIN_USERNAME=admin
DEFAULT_ADMIN_PASSWORD=${secret()}
DEFAULT_PROXY_API_KEY=sk-${secret()}
SESSION_SECRET=${secret()}
CREDENTIAL_ENCRYPTION_KEY=${secret()}
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}
TIMEZONE=UTC
NEXT_PUBLIC_TIMEZONE=UTC
DATABASE_URL=postgresql://rawroute:${databasePassword}@postgres:5432/rawroute
DATABASE_POOL_MAX=4
DATABASE_CHILD_READ_CONCURRENCY=2
DATABASE_ANALYTICS_READ_CONCURRENCY=2
REDIS_URL=redis://redis:6379
REDIS_COMMAND_TIMEOUT_MS=250
MAX_WORKSPACE_CACHE_ENTRIES=32
MAX_PROVIDER_SCOPED_CACHE_ENTRIES=32
RAWROUTE_PUBLIC_URL=http://localhost:8080
CLIPROXY_URL=http://cli-proxy-api:8317
CLIPROXY_MANAGEMENT_KEY=${managementKey}
CLIPROXY_API_KEY=${apiKey}
`,
  "postgres.env": `POSTGRES_DB=rawroute
POSTGRES_USER=rawroute
POSTGRES_PASSWORD=${databasePassword}
`,
  "cliproxy.env": `MANAGEMENT_PASSWORD=${managementKey}
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
