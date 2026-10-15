import { afterEach } from "bun:test"

// Each isolated test file gets its own database, never a developer's persisted data.
// Set this before capturing the environment so afterEach preserves the safe default.
process.env.SQLITE_PATH = ":memory:"

const environment = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(environment, key)) delete process.env[key]
  }
  Object.assign(process.env, environment)
})
