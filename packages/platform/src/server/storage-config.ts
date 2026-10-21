import { getDatabase } from "./database"

export function isMemoryBackend() {
  return process.env.NODE_ENV === "test" && process.env.STORAGE_BACKEND !== "sqlite"
}

export function collectionPrefix(connection?: ReturnType<typeof getDatabase>) {
  if (!connection && isMemoryBackend()) return "rawroute"
  const database = connection ?? getDatabase()
  const existing = prefixes.get(database)
  if (existing) return existing
  const table = database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='rawroute_documents'").get()
  const roots = table ? database.query<{ root: string }, []>("SELECT DISTINCT substr(collection_path,1,instr(collection_path || '/','/')-1) AS root FROM rawroute_documents").all() : []
  const namespaces = new Set(roots.flatMap(({ root }) => {
    const match = root.match(/^(.+)_(?:system|workspaces|usage_events|usage_rollups|model_shares|workspace_deletions|audit|codex_login_cancellations)$/)
    return match?.[1] ? [match[1]] : []
  }))
  const projection = database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_projection_meta'").get()
  const metadata = projection ? database.query<{ documentPrefix: string }, []>("SELECT documentPrefix FROM usage_projection_meta WHERE id=1").get() : null
  if (metadata?.documentPrefix) namespaces.add(metadata.documentPrefix)
  if (namespaces.size > 1) throw new Error("Multiple application namespaces found; use a separate database per deployment.")
  // Existing databases keep their physical namespace; new databases are canonical.
  const prefix = namespaces.values().next().value || "rawroute"
  prefixes.set(database, prefix)
  return prefix
}

const prefixes = new WeakMap<ReturnType<typeof getDatabase>, string>()
