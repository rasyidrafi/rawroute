import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { collectionPrefix } from "../../packages/platform/src/server/storage-config"

const modules = (path: string) => JSON.stringify(resolve(path))
const program = `
import ${modules("apps/console/src/server/composition")};
import { identity, createSession, isAuthenticated } from ${modules("packages/platform/src/server/runtime.ts")};
import { hashPassword, verifyPassword } from ${modules("packages/platform/src/server/identity.ts")};
import { closeLocalDatabase } from ${modules("packages/platform/src/server/database.ts")};
import { runInWorkspace } from ${modules("packages/platform/src/server/workspace-context.ts")};
import { listApiKeys, listProviders, upsertProvider, upsertProviderApiKey, listProviderApiKeys } from ${modules("packages/gateway-ai/src/server/store.ts")};
const input = JSON.parse(await Bun.stdin.text());
const identities = await Promise.all(Array.from({length: 12}, () => identity.readMeta()));
const meta = identities[0];
if (input.create) {
  if (!verifyPassword("123456", meta.admin.passwordHash) || !meta.admin.mustChangePassword) throw Error("Wrong initial credentials");
  await identity.updateMeta(value => { value.admin.passwordHash = hashPassword("saved-private-password"); value.admin.mustChangePassword = false });
  await runInWorkspace({id: "default"}, async () => {
    const provider = await upsertProvider({id: "persisted-provider", name: "Fixture", prefix: "fixture", baseUrl: "https://provider.example/v1", protocol: "openai-chat", authType: "bearer", enabled: true});
    await upsertProviderApiKey(provider.id, {name: "External credential", key: "fixture-external-provider-secret"});
  });
}
const saved = await identity.readMeta();
const result = await runInWorkspace({id: "default"}, async () => ({keys: await listApiKeys(), providerKeys: await listProviderApiKeys((await listProviders()).find(value => value.prefix === "fixture").id)}));
const cookie = input.cookie || (await createSession(new Request("https://public.example"))).split(";", 1)[0];
console.log(JSON.stringify({...result, sessionSecret: saved.sessionSecret, initialSecrets: identities.map(value => value.sessionSecret), cookie,
  authenticated: await isAuthenticated(new Request("https://public.example", {headers: {cookie}})),
  privatePassword: verifyPassword("saved-private-password", saved.admin.passwordHash), mustChangePassword: saved.admin.mustChangePassword}));
await closeLocalDatabase();
`

async function boot(file: string, input: { create?: boolean; cookie?: string }) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", program], {
    env: { ...process.env, NODE_ENV: "production", SQLITE_PATH: file, STORAGE_ENABLED: "false",
      STORAGE_BACKEND: "memory", DEFAULT_ADMIN_PASSWORD: "ignored", SESSION_SECRET: "ignored",
      DEFAULT_PROXY_API_KEY: "ignored", DATABASE_COLLECTION_PREFIX: "ignored" },
    stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: "pipe", stderr: "pipe",
  })
  const output = await new Response(child.stdout).text()
  expect(await new Response(child.stderr).text()).toBe("")
  expect(await child.exited).toBe(0)
  return JSON.parse(output) as { keys: { key: string }[]; providerKeys: { key: string }[]; sessionSecret: string; initialSecrets: string[]; cookie: string; authenticated: boolean; privatePassword: boolean; mustChangePassword: boolean }
}

test.each([false, true])("production bootstrap generates once and preserves passwords, sessions and provider/gateway keys on process restart (existing namespace: %s)", async legacy => {
  const directory = mkdtempSync("/tmp/opencode/automatic-bootstrap-")
  const file = join(directory, "rawroute.sqlite")
  try {
    const first = await boot(file, { create: true })
    expect(first.keys).toHaveLength(1)
    expect(first.keys[0]!.key).toMatch(/^sk-[a-f0-9]{64}$/)
    expect(first.sessionSecret).toMatch(/^[a-f0-9]{64}$/)
    expect(new Set(first.initialSecrets).size).toBe(1)
    if (legacy) {
      const db = new Database(file)
      try {
        db.run("UPDATE rawroute_documents SET path='existing' || substr(path,9), collection_path='existing' || substr(collection_path,9) WHERE path LIKE 'rawroute_%'")
        db.run("UPDATE usage_projection_meta SET documentPrefix='existing'")
      } finally { db.close() }
    }
    const second = await boot(file, { cookie: first.cookie })
    expect(second.keys).toEqual(first.keys)
    expect(second.providerKeys).toEqual(first.providerKeys)
    expect(second.providerKeys[0]!.key).toBe("fixture-external-provider-secret")
    expect(second.sessionSecret).toBe(first.sessionSecret)
    expect(second.authenticated).toBe(true)
    expect(second.privatePassword).toBe(true)
    expect(second.mustChangePassword).toBe(false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("persisted namespace detection rejects ambiguous databases instead of bootstrapping a new administrator", () => {
  const db = new Database(":memory:")
  try {
    db.run("CREATE TABLE rawroute_documents(collection_path TEXT)")
    db.run("INSERT INTO rawroute_documents VALUES ('one_system'),('two_workspaces/default/providers')")
    expect(() => collectionPrefix(db)).toThrow("Multiple application namespaces")
  } finally { db.close() }
})

test("an empty persisted projection retains its existing namespace without an environment setting", () => {
  const db = new Database(":memory:")
  try {
    db.run("CREATE TABLE usage_projection_meta(id INTEGER PRIMARY KEY, documentPrefix TEXT)")
    db.run("INSERT INTO usage_projection_meta VALUES (1,'existing')")
    expect(collectionPrefix(db)).toBe("existing")
  } finally { db.close() }
})
