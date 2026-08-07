import { backfillApiKeyIndexes } from "../src/lib/store"

function hasFlag(name: string) {
  return process.argv.slice(2).includes(name)
}

async function main() {
  if ((process.env.STORAGE_BACKEND || "firestore") !== "firestore") {
    throw new Error("Set STORAGE_BACKEND=firestore before running this maintenance command.")
  }
  const result = await backfillApiKeyIndexes({ dryRun: hasFlag("--dry-run") })
  // Counts only. API key values, hashes, document IDs, and workspace IDs are
  // deliberately never printed by this maintenance command.
  console.log(JSON.stringify({ ok: true, ...result }, null, 2))
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
