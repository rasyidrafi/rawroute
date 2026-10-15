import { migrateUsageProjection } from "./usage-projection-store"

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => args[args.indexOf(flag) + 1]
  if (!args.includes("--sqlite") || !args.includes("--timezone")) throw new Error("Usage: bun run --no-env-file scripts/migrations/usage-projection.ts --sqlite <file> --timezone <IANA zone> [--apply --writers-stopped] [--backup <new-file>]")
  console.log(JSON.stringify(migrateUsageProjection(value("--sqlite")!, { timeZone: value("--timezone")!, apply: args.includes("--apply"), writersStopped: args.includes("--writers-stopped"), backup: args.includes("--backup") ? value("--backup") : undefined }), null, 2))
}
