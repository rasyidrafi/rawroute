import { rm } from "node:fs/promises"
import tailwind from "bun-plugin-tailwind"

await rm("dist", { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  plugins: [tailwind],
  target: "bun",
  splitting: true,
  minify: true,
  env: "disable",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  external: ["pg", "ioredis"],
})

for (const message of result.logs) console.error(message)
if (!result.success) process.exit(1)
const migration = await Bun.build({ entrypoints: ["./scripts/import-cliproxy.ts"], outdir: "./dist", target: "bun", minify: true, env: "disable" })
for (const message of migration.logs) console.error(message)
if (!migration.success) process.exit(1)
console.log(`Built ${result.outputs.length + migration.outputs.length} production files in dist/`)
