import { afterEach } from "bun:test"

const environment = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(environment, key)) delete process.env[key]
  }
  Object.assign(process.env, environment)
})
