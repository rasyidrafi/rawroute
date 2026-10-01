import { listMappedCodexAccounts } from "@/lib/codex/cliproxy"
import { getProvider, listProviders, upsertProvider } from "@/server/store"
import type { Provider, ProviderApiKey } from "@/lib/types"
import { currentWorkspaceId } from "@/lib/workspace/context"

const CODEX_PROVIDER_PREFIX = "codex"
const CODEX_PROVIDER_NAME = "Codex OAuth"
const codexProviderEnsureInflight = new Map<string, Promise<Provider>>()

function codexBaseUrl() {
  return (process.env.CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex").replace(/\/$/, "")
}

export async function ensureCodexProvider(): Promise<Provider> {
  const workspaceId = currentWorkspaceId()
  const inflight = codexProviderEnsureInflight.get(workspaceId)
  if (inflight) return inflight
  const promise = (async () => {
    const providers = await listProviders()
    const existing = providers.find((provider) => provider.prefix === CODEX_PROVIDER_PREFIX)
    const provider = existing || await upsertProvider({
      name: CODEX_PROVIDER_NAME,
      prefix: CODEX_PROVIDER_PREFIX,
      baseUrl: codexBaseUrl(),
      protocol: "openai-responses",
      authType: "bearer",
      headers: {},
      enabled: true,
    })
    if (provider.protocol !== "openai-responses" || provider.authType !== "bearer" || provider.baseUrl !== codexBaseUrl()) {
      throw new Error(`Provider prefix ${CODEX_PROVIDER_PREFIX} is already configured for a different upstream.`)
    }

    return (await getProvider(provider.id)) || provider
  })()
  codexProviderEnsureInflight.set(workspaceId, promise)
  try {
    return await promise
  } finally {
    if (codexProviderEnsureInflight.get(workspaceId) === promise) codexProviderEnsureInflight.delete(workspaceId)
  }
}

export async function listCodexAccounts() {
  // CLIProxy owns every mutable OAuth field. RawRoute keeps only its stable
  // workspace-to-auth-file mapping and overlays the live management state.
  const provider = (await listProviders()).find((entry) => entry.prefix === CODEX_PROVIDER_PREFIX)
  if (!provider) return { provider: null, accounts: [] as ProviderApiKey[] }
  return { provider, accounts: await listMappedCodexAccounts(provider) }
}
