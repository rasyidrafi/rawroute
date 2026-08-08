import { loadEnvConfig } from "@next/env"
import { applicationDefault, cert, getApp, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, type DocumentData } from "firebase-admin/firestore"

import { syncCodexAccountsToCliProxy } from "@/lib/cliproxy-codex"
import { closeLocalDatabase } from "@/lib/local-db"
import { listProviderApiKeys, listProviderModels, listProviders, listAliases, upsertAlias, upsertModel, upsertProvider, upsertProviderApiKey, deleteProviderApiKey } from "@/lib/store"
import { listWorkspaces } from "@/lib/workspaces"
import { runInWorkspace } from "@/lib/workspace-context"
import type { Model, ModelAlias, Provider, ProviderApiKey, Workspace } from "@/lib/types"

loadEnvConfig(process.cwd())

const prefix = (process.env.SOURCE_FIRESTORE_COLLECTION_PREFIX || process.env.FIRESTORE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_")
const databaseId = process.env.SOURCE_FIRESTORE_DATABASE_ID || process.env.FIRESTORE_DATABASE_ID || "(default)"

type SourceProvider = Omit<Provider, "id" | "apiKeyCount" | "enabledApiKeyCount" | "modelCount" | "enabledModelCount"> & { id: string }
type SourceModel = Omit<Model, "id" | "providerId"> & { id: string }
type SourceAccount = Omit<ProviderApiKey, "id" | "providerId" | "key"> & { id: string; key: string }

function sourceValue(name: string, fallback?: string) {
  return process.env[`SOURCE_${name}`] || process.env[name] || fallback
}

function sourceFirestore() {
  const projectId = sourceValue("FIREBASE_PROJECT_ID") || sourceValue("GOOGLE_CLOUD_PROJECT") || sourceValue("GCLOUD_PROJECT")
  const clientEmail = sourceValue("FIREBASE_CLIENT_EMAIL")
  const privateKey = sourceValue("FIREBASE_PRIVATE_KEY")?.replaceAll("\\n", "\n")
  const app = getApps().length
    ? getApp()
    : initializeApp({ credential: projectId && clientEmail && privateKey ? cert({ projectId, clientEmail, privateKey }) : applicationDefault(), projectId })
  return getFirestore(app, databaseId)
}

function normalizedName(value: unknown) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : ""
}

function sourceDate(value: unknown) {
  if (value && typeof value === "object" && "toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString()
  }
  return typeof value === "string" ? value : undefined
}

function sourceString(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function sourceProvider(data: DocumentData, id: string): SourceProvider {
  return {
    id,
    name: sourceString(data.name) || "Codex OAuth",
    prefix: sourceString(data.prefix) || "codex",
    baseUrl: sourceString(data.baseUrl) || "https://chatgpt.com/backend-api/codex",
    protocol: data.protocol === "openai-chat" || data.protocol === "anthropic-messages" ? data.protocol : "openai-responses",
    authType: data.authType === "x-api-key" || data.authType === "custom-header" || data.authType === "none" ? data.authType : "bearer",
    headers: data.headers && typeof data.headers === "object" && !Array.isArray(data.headers) ? data.headers as Record<string, string> : {},
    enabled: data.enabled !== false,
    createdAt: sourceDate(data.createdAt) || new Date().toISOString(),
  }
}

function sourceModel(data: DocumentData, id: string): SourceModel {
  return {
    id,
    name: sourceString(data.name) || sourceString(data.gatewayModelId) || id,
    upstreamModel: sourceString(data.upstreamModel) || sourceString(data.gatewayModelId) || id,
    gatewayModelId: sourceString(data.gatewayModelId) || sourceString(data.upstreamModel) || id,
    protocol: data.protocol === "openai-chat" || data.protocol === "anthropic-messages" ? data.protocol : "openai-responses",
    upstreamPath: sourceString(data.upstreamPath),
    requestOverrides: data.requestOverrides && typeof data.requestOverrides === "object" && !Array.isArray(data.requestOverrides) ? data.requestOverrides as Record<string, unknown> : {},
    enabled: data.enabled !== false,
    createdAt: sourceDate(data.createdAt) || new Date().toISOString(),
  }
}

function sourceAccount(data: DocumentData, id: string): SourceAccount {
  const key = sourceString(data.key)
  if (!key) throw new Error(`Source Codex account ${id} is missing its access token.`)
  return {
    id,
    key,
    name: sourceString(data.name) || sourceString(data.email) || "Codex account",
    credentialKind: "codex-oauth",
    refreshToken: sourceString(data.refreshToken),
    idToken: sourceString(data.idToken),
    accountId: sourceString(data.accountId),
    email: sourceString(data.email),
    planType: sourceString(data.planType),
    expiresAt: sourceDate(data.expiresAt),
    lastRefresh: sourceDate(data.lastRefresh),
    enabled: data.enabled !== false,
    rpmLimit: typeof data.rpmLimit === "number" ? data.rpmLimit : undefined,
    maxConcurrency: typeof data.maxConcurrency === "number" ? data.maxConcurrency : undefined,
    priority: typeof data.priority === "number" ? data.priority : undefined,
    createdAt: sourceDate(data.createdAt) || new Date().toISOString(),
  }
}

async function sourceScope(name: string, workspaceId: string, providerPath: string, aliasesPath: string) {
  const firestore = sourceFirestore()
  const providers = await firestore.collection(providerPath).get()
  const providerDoc = providers.docs.find((document) => document.data().prefix === "codex")
  if (!providerDoc) throw new Error(`Source ${name} workspace has no Codex provider.`)
  const provider = sourceProvider(providerDoc.data(), providerDoc.id)
  const [keySnapshot, modelSnapshot, aliasSnapshot] = await Promise.all([
    firestore.collection(`${providerDoc.ref.path}/apiKeys`).get(),
    firestore.collection(`${providerDoc.ref.path}/models`).get(),
    firestore.collection(aliasesPath).get(),
  ])
  return {
    name,
    workspaceId,
    provider,
    accounts: keySnapshot.docs.map((document) => sourceAccount(document.data(), document.id)),
    models: modelSnapshot.docs.map((document) => sourceModel(document.data(), document.id)),
    aliases: aliasSnapshot.docs.map((document) => ({
      id: document.id,
      alias: sourceString(document.data().alias) || "",
      name: sourceString(document.data().name) || sourceString(document.data().alias) || "",
      targetModelId: sourceString(document.data().targetModelId) || "",
      createdAt: sourceDate(document.data().createdAt) || new Date().toISOString(),
    } satisfies ModelAlias)),
  }
}

async function sourceScopes() {
  const firestore = sourceFirestore()
  const workspaceSnapshot = await firestore.collection(`${prefix}_workspaces`).get()
  const sourceWorkspaces = workspaceSnapshot.docs.map((document) => ({ id: document.id, name: sourceString(document.data().name) || document.id }))
  const defaultId = sourceWorkspaces.find((workspace) => workspace.id === "default" || normalizedName(workspace.name) === "default")?.id || "default"
  const htWorkspace = sourceWorkspaces.find((workspace) => normalizedName(workspace.name) === "ht nonshi")
  if (!htWorkspace) throw new Error("Source HT NonSHI workspace was not found.")
  return [
    await sourceScope("Default", defaultId, `${prefix}/providers/providers`, `${prefix}/aliases/aliases`),
    await sourceScope("HT NonSHI", htWorkspace.id, `${prefix}_workspaces/${htWorkspace.id}/providers`, `${prefix}_workspaces/${htWorkspace.id}/aliases`),
  ]
}

function targetWorkspace(workspaces: Workspace[], name: string) {
  const workspace = workspaces.find((entry) => normalizedName(entry.name) === normalizedName(name))
  if (!workspace) throw new Error(`Target ${name} workspace was not found.`)
  return workspace
}

async function migrateScope(source: Awaited<ReturnType<typeof sourceScope>>, workspace: Workspace) {
  return runInWorkspace(workspace, async () => {
    const configured = (await listProviders()).find((provider) => provider.prefix === "codex")
    const provider = await upsertProvider({
      ...(configured ? { originalId: configured.id } : {}),
      name: source.provider.name,
      prefix: source.provider.prefix,
      baseUrl: source.provider.baseUrl,
      protocol: source.provider.protocol,
      authType: source.provider.authType,
      headers: source.provider.headers,
      enabled: source.provider.enabled,
    })

    const currentModels = await listProviderModels(provider.id)
    for (const model of source.models) {
      const existing = currentModels.find((entry) => entry.gatewayModelId === model.gatewayModelId)
      await upsertModel(provider.id, {
        ...(existing ? { originalId: existing.id } : {}),
        name: model.name,
        upstreamModel: model.upstreamModel,
        gatewayModelId: model.gatewayModelId,
        protocol: model.protocol,
        upstreamPath: model.upstreamPath,
        requestOverrides: model.requestOverrides,
        enabled: model.enabled,
      })
    }

    const currentAccounts = await listProviderApiKeys(provider.id)
    const sourceAccountIds = new Set(source.accounts.map((account) => account.accountId || account.id))
    for (const account of source.accounts) {
      const identity = account.accountId || account.id
      const existing = currentAccounts.find((entry) => (entry.accountId || entry.id) === identity)
      await upsertProviderApiKey(provider.id, {
        ...(existing ? { originalId: existing.id } : {}),
        name: account.name,
        key: account.key,
        credentialKind: "codex-oauth",
        refreshToken: account.refreshToken,
        idToken: account.idToken,
        accountId: account.accountId,
        email: account.email,
        planType: account.planType,
        expiresAt: account.expiresAt,
        lastRefresh: account.lastRefresh,
        enabled: account.enabled,
        rpmLimit: account.rpmLimit,
        maxConcurrency: account.maxConcurrency,
        priority: account.priority,
      })
    }
    for (const account of currentAccounts) {
      if (account.credentialKind === "codex-oauth" && !sourceAccountIds.has(account.accountId || account.id)) {
        await deleteProviderApiKey(provider.id, account.id)
      }
    }

    const currentAliases = await listAliases()
    for (const alias of source.aliases) {
      if (!alias.alias || !alias.targetModelId) continue
      const existing = currentAliases.find((entry) => entry.alias === alias.alias)
      await upsertAlias({
        ...(existing ? { originalId: existing.id } : {}),
        alias: alias.alias,
        name: alias.name,
        targetModelId: alias.targetModelId,
      })
    }
    return {
      workspace: workspace.name,
      accounts: source.accounts.length,
      models: source.models.length,
      aliases: source.aliases.length,
    }
  })
}

async function main() {
  const [sources, workspaces] = await Promise.all([sourceScopes(), listWorkspaces()])
  const summaries = []
  for (const source of sources) summaries.push(await migrateScope(source, targetWorkspace(workspaces, source.name)))
  const cliProxy = await syncCodexAccountsToCliProxy({ force: true })
  console.log(JSON.stringify({ prefix, summaries, cliProxy: { accounts: cliProxy.accounts, uploaded: cliProxy.uploaded, removed: cliProxy.removed } }, null, 2))
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}).finally(() => closeLocalDatabase())
