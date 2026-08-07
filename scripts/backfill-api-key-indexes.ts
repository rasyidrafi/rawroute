import { loadEnvConfig } from "@next/env"

import { closeLocalDatabase } from "../src/lib/local-db"
import { backfillApiKeyIndexes } from "../src/lib/store"

loadEnvConfig(process.cwd())

function hasFlag(name: string) {
  return process.argv.slice(2).includes(name)
}

async function main() {
  try {
    if (process.env.STORAGE_BACKEND === "memory" || process.env.NODE_ENV === "test") {
      throw new Error("API key index backfill requires the PostgreSQL storage backend.")
    }
    const result = await backfillApiKeyIndexes({ dryRun: hasFlag("--dry-run") })
    // Counts only. API key values, hashes, document IDs, and workspace IDs are
    // deliberately never printed by this maintenance command.
    console.log(JSON.stringify({ ok: true, ...result }, null, 2))
  } finally {
    await closeLocalDatabase()
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
