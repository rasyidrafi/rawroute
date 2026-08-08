import { loadEnvConfig } from "@next/env"
import { Client } from "pg"

loadEnvConfig(process.cwd())

const targets = [
  { id: "09f41154-9cc4-45c8-8ea9-8a8cde14b1e6", name: "Unlimited GPT-5.3 Codex Spark" },
  { id: "0f66f287-bbb1-409e-a7b0-ddaccb1d8784", name: "CCS imported 18" },
] as const
const targetIds = targets.map((target) => target.id)
const dryRun = process.argv.includes("--dry-run")

type Count = { category: string; deleted: number }

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const counts: Count[] = []
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
    const keys = await client.query<{ document_id: string; name: string }>(
      `SELECT document_id, data->>'name' AS name
       FROM rawroute_documents
       WHERE collection_path = 'rawroute/apiKeys/apiKeys' AND document_id = ANY($1::text[])`,
      [targetIds],
    )
    for (const target of targets) {
      const matches = keys.rows.filter((row) => row.document_id === target.id)
      if (matches.length !== 1 || matches[0].name !== target.name) {
        throw new Error(`Refusing to delete ${target.name}: exact Default workspace key record was not found.`)
      }
    }

    const remove = async (category: string, sql: string, params: unknown[] = []) => {
      const result = await client.query(sql, params)
      counts.push({ category, deleted: result.rowCount || 0 })
    }

    await remove("gateway keys", `DELETE FROM rawroute_documents WHERE collection_path = 'rawroute/apiKeys/apiKeys' AND document_id = ANY($1::text[])`, [targetIds])
    await remove("API-key indexes", `DELETE FROM rawroute_documents WHERE collection_path = 'rawroute_api_key_indexes' AND data->>'apiKeyId' = ANY($1::text[])`, [targetIds])
    await remove("usage events", `DELETE FROM rawroute_documents WHERE collection_path LIKE '%usage_events%' AND (data->>'gatewayKeyId' = ANY($1::text[]) OR data->>'apiKeyId' = ANY($1::text[]))`, [targetIds])
    await remove("usage rollups", `DELETE FROM rawroute_documents WHERE collection_path LIKE '%usage_rollups%' AND (data->>'gatewayKeyId' = ANY($1::text[]) OR data->>'apiKeyId' = ANY($1::text[]))`, [targetIds])
    await remove("budgets", `DELETE FROM rawroute_documents WHERE collection_path LIKE '%budgets%' AND data->>'apiKeyId' = ANY($1::text[])`, [targetIds])
    await remove("budget counters", `DELETE FROM rawroute_documents WHERE collection_path LIKE '%budgetCounters%' AND data->>'apiKeyId' = ANY($1::text[])`, [targetIds])
    await remove("budget bypass sessions", `DELETE FROM rawroute_documents WHERE collection_path LIKE '%budget_bypass_sessions%' AND data->>'apiKeyId' = ANY($1::text[])`, [targetIds])

    if (dryRun) await client.query("ROLLBACK")
    else await client.query("COMMIT")
    console.log(JSON.stringify({ dryRun, targets: targets.map(({ id, name }) => ({ id, name })), counts }, null, 2))
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
