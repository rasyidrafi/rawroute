import { readFileSync } from "node:fs"
import { Pool } from "pg"
import { convertDocument } from "./migrations/current-data"
import { listCliProxyCodexAuthFiles } from "../src/lib/codex/cliproxy"

// Stop RawRoute and take a database backup before --apply. Default is a dry run.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.")
const apply = process.argv.includes("--apply")
const prefix = (process.env.DATABASE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_")
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()
try {
  await client.query("BEGIN")
  await client.query("LOCK TABLE rawroute_documents IN EXCLUSIVE MODE")
  const result = await client.query<{ path: string; data: Record<string, unknown> }>(
    "SELECT path, data FROM rawroute_documents WHERE split_part(path, '/', 1) = ANY($1::text[]) ORDER BY path FOR UPDATE",
    [[`${prefix}_system`, `${prefix}_workspaces`]],
  )
  const authFilePath = process.argv.find(arg => arg.startsWith("--auth-files="))?.slice("--auth-files=".length)
  const payload: unknown = authFilePath ? JSON.parse(readFileSync(authFilePath, "utf8")) : undefined
  const exported = payload && typeof payload === "object" && "files" in payload ? payload.files : payload
  if (authFilePath && !Array.isArray(exported)) throw new Error("Auth-file export must contain a files array.")
  const files = Array.isArray(exported) ? exported.map((entry: Record<string, unknown>) => {
    if (!entry || typeof entry.name !== "string" || typeof entry.disabled !== "boolean") throw new Error("Auth-file metadata requires name and disabled fields.")
    return { name: entry.name, disabled: entry.disabled, authIndex: typeof entry.authIndex === "string" ? entry.authIndex : typeof entry.auth_index === "string" ? entry.auth_index : undefined }
  }) : result.rows.some(row => row.data.credentialKind === "codex-oauth") ? await listCliProxyCodexAuthFiles() : []
  const changes = result.rows.map(row => ({ before: row, after: convertDocument(row, files) })).filter(({ before, after }) => JSON.stringify(before.data) !== JSON.stringify(after.data))
  if (apply) {
    for (const { after } of changes) await client.query("UPDATE rawroute_documents SET data = $2::jsonb, updated_at = now() WHERE path = $1", [after.path, JSON.stringify(after.data)])
  }
  await client.query(apply ? "COMMIT" : "ROLLBACK")
  console.log(JSON.stringify({ mode: apply ? "applied" : "dry-run", scanned: result.rows.length, converted: changes.length }))
} catch (error) {
  await client.query("ROLLBACK")
  throw error
} finally {
  client.release()
  await pool.end()
}
