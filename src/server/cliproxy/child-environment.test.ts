import { expect, test } from "bun:test"
import { childEnvironment } from "./child-environment"

test("child receives runtime tuning and proxies without RawRoute credentials", () => {
  process.env.NODE_ENV = "production"
  process.env.DATABASE_URL = "postgres://private-password"
  process.env.SESSION_SECRET = "private-session"
  process.env.CREDENTIAL_ENCRYPTION_KEY = "private-encryption"
  process.env.MANAGEMENT_PASSWORD = "unrelated-legacy-management-key"
  process.env.GOMEMLIMIT = "80MiB"
  process.env.HTTPS_PROXY = "http://local-proxy:1234"
  const env = childEnvironment("/data/cliproxy")
  expect(env).toMatchObject({ GOMEMLIMIT: "80MiB", HTTPS_PROXY: "http://local-proxy:1234", HOME: "/data/cliproxy" })
  for (const key of ["DATABASE_URL", "SESSION_SECRET", "CREDENTIAL_ENCRYPTION_KEY", "MANAGEMENT_PASSWORD"]) expect(env).not.toHaveProperty(key)
})
