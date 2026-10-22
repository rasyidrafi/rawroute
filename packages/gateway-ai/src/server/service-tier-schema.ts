import type { Database } from "bun:sqlite"

export function createServiceTierSchema(database: Database) {
  database.run("CREATE TABLE IF NOT EXISTS ai_service_tier_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)")
  database.run("INSERT OR REPLACE INTO ai_service_tier_schema (id, version) VALUES (1, 3)")
}

export function hasServiceTierSchema(database: Database) {
  return Boolean(database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_service_tier_schema'").get())
    && database.query<{ version: number }, []>("SELECT version FROM ai_service_tier_schema WHERE id = 1").get()?.version === 3
}

export function assertServiceTierSchema(database: Database, initial = false) {
  if (initial) createServiceTierSchema(database)
  if (!hasServiceTierSchema(database)) throw new Error("Service tier pricing requires offline migration: scripts/migrations/service-tier-pricing.ts")
}
