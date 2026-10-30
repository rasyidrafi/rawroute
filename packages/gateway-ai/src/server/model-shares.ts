import { createHash } from "node:crypto"

import { getSqliteDatabase, type SqliteDatabase } from "@rawroute/platform/server/database"
import { listModels, listProviders } from "./store"
import { collectionPrefix, isMemoryBackend } from "@rawroute/platform/server/storage-config"
import type { ModelShare, SharedModelView } from "../contracts/domain"
import { currentWorkspaceId, runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { getWorkspace, listWorkspaces } from "@rawroute/platform/server/runtime"
import { appendMemoryAudit } from "@rawroute/platform/server/audit"
import { attachWorkspaceActivity } from "@rawroute/platform/server/workspace-activity"
import { modelUnavailable } from "../contracts/catalog"
import { getBudgetWindow } from "./analytics"

let localDatabase: SqliteDatabase | undefined
declare global { var __rawrouteModelShares: Map<string, ModelShare> | undefined }

function db() { return localDatabase ||= getSqliteDatabase() }
function prefix() { return collectionPrefix() }
function sharesRef() { return db().collection(`${prefix()}_model_shares`) }
function memoryShares() { return globalThis.__rawrouteModelShares ||= new Map<string, ModelShare>() }
function shareId(ownerWorkspaceId: string, sourceModelId: string, recipientWorkspaceId: string) {
  return `share-${createHash("sha256").update(`${ownerWorkspaceId}:${sourceModelId}:${recipientWorkspaceId}`).digest("hex").slice(0, 24)}`
}

async function readShares() {
  if (isMemoryBackend()) return [...memoryShares().values()]
  const snapshot = await sharesRef().get()
  return snapshot.docs.map((document) => {
    const share = { ...document.data(), id: document.id } as ModelShare
    if (typeof share.onlyDuringUnlimited !== "boolean") throw new Error("Model sharing requires the offline model-share-conditions migration.")
    return share
  })
}

async function writeShares(shares: ModelShare[]) {
  if (!shares.length) return
  if (isMemoryBackend()) {
    for (const share of shares) memoryShares().set(share.id, share)
    appendMemoryAudit({ resource: "model-sharing", action: "config.update", workspaceId: currentWorkspaceId(), result: "success" })
    return
  }
  const batch = db().batch()
  for (const share of shares) {
    const { id, ...data } = share
    batch.set(sharesRef().doc(id), data)
  }
  await batch.commit()
}

async function activeSource(share: ModelShare) {
  const owner = await getWorkspace(share.ownerWorkspaceId)
  if (!owner || owner.status !== "active") return undefined
  return runInWorkspace(owner, async () => {
    const [models, providers] = await Promise.all([listModels(), listProviders()])
    const model = models.find((entry) => entry.id === share.sourceModelId)
    const provider = model ? providers.find((entry) => entry.id === model.providerId) : undefined
    if (!model || !provider || !model.enabled || modelUnavailable(model) || provider.enabled === false) return undefined
    const paused = share.onlyDuringUnlimited && !(await getBudgetWindow()).bypassLimits
    return { owner, model, provider, paused }
  })
}

function viewFor(share: ModelShare, source: Awaited<ReturnType<typeof activeSource>>) : SharedModelView {
  const ownerName = source?.owner.name || share.ownerWorkspaceId
  const gatewayModelId = source?.model.gatewayModelId || share.sourceGatewayModelId
  return {
    id: share.id,
    ownerWorkspaceId: share.ownerWorkspaceId,
    ownerWorkspaceName: ownerName,
    sourceProviderId: share.sourceProviderId,
    sourceModelId: share.sourceModelId,
    sourceGatewayModelId: gatewayModelId,
    sourceModelName: source?.model.name || gatewayModelId,
    providerName: source?.provider.name || "Unavailable provider",
    qualifiedModelId: `${share.ownerWorkspaceId}/${gatewayModelId}`,
    status: share.status === "active" && source ? source.paused ? "paused" : "active" : share.status === "revoked" ? "revoked" : "unavailable",
  }
}

export async function listSharedModelsForRecipient(recipientWorkspaceId = currentWorkspaceId()) {
  const shares = (await readShares()).filter((share) => share.recipientWorkspaceId === recipientWorkspaceId)
  const views = await Promise.all(shares.map(async (share) => viewFor(share, share.status === "active" ? await activeSource(share) : undefined)))
  return views.sort((left, right) => left.ownerWorkspaceName.localeCompare(right.ownerWorkspaceName) || left.sourceModelName.localeCompare(right.sourceModelName))
}

export async function listModelSharesForSourceModel(sourceModelId: string, ownerWorkspaceId = currentWorkspaceId()) {
  const shares = (await readShares()).filter((share) => share.ownerWorkspaceId === ownerWorkspaceId && share.sourceModelId === sourceModelId)
  const workspaces = new Map((await listWorkspaces()).map((workspace) => [workspace.id, workspace]))
  return shares.map((share) => ({ ...share, recipientWorkspaceName: workspaces.get(share.recipientWorkspaceId)?.name || share.recipientWorkspaceId }))
    .sort((left, right) => left.recipientWorkspaceName.localeCompare(right.recipientWorkspaceName))
}

export async function listShareTargets(sourceModelId: string) {
  const ownerWorkspaceId = currentWorkspaceId()
  const [workspaces, shares] = await Promise.all([listWorkspaces(), listModelSharesForSourceModel(sourceModelId, ownerWorkspaceId)])
  const byRecipient = new Map(shares.map(share => [share.recipientWorkspaceId, share]))
  return workspaces.filter((workspace) => workspace.status === "active" && workspace.id !== ownerWorkspaceId)
    .map((workspace) => ({ id: workspace.id, name: workspace.name, shared: byRecipient.get(workspace.id)?.status === "active", onlyDuringUnlimited: byRecipient.get(workspace.id)?.onlyDuringUnlimited === true }))
}

export async function setModelShareTargets(sourceModelId: string, recipientWorkspaceIds: string[], unlimitedOnlyWorkspaceIds: string[] = []) {
  const ownerWorkspaceId = currentWorkspaceId()
  const [models, providers, workspaces, current] = await Promise.all([listModels(), listProviders(), listWorkspaces(), listModelSharesForSourceModel(sourceModelId, ownerWorkspaceId)])
  const model = models.find((entry) => entry.id === sourceModelId)
  const provider = model ? providers.find((entry) => entry.id === model.providerId) : undefined
  if (!model || !provider || !model.enabled || modelUnavailable(model) || provider.enabled === false) throw new Error("Only available enabled models on enabled providers can be shared.")
  const activeWorkspaceIds = new Set(workspaces.filter((workspace) => workspace.status === "active").map((workspace) => workspace.id))
  const recipients = [...new Set(recipientWorkspaceIds.filter((id): id is string => typeof id === "string"))]
  if (recipients.some((id) => id === ownerWorkspaceId)) throw new Error("A model cannot be shared with its own workspace.")
  if (recipients.some((id) => !activeWorkspaceIds.has(id))) throw new Error("One or more target workspaces are unavailable.")
  const selected = new Set(recipients)
  const conditional = new Set(unlimitedOnlyWorkspaceIds)
  if ([...conditional].some(id => typeof id !== "string" || !selected.has(id))) throw new Error("Unlimited Mode conditions must refer to selected workspaces.")
  const now = new Date().toISOString()
  const currentByRecipient = new Map(current.map((share) => [share.recipientWorkspaceId, share]))
  const writes: ModelShare[] = []
  for (const recipientWorkspaceId of new Set([...currentByRecipient.keys(), ...selected])) {
    if (!activeWorkspaceIds.has(recipientWorkspaceId)) continue
    // A recipient deletion must drain this owner-side write too. Attach before
    // queuing persistence, so a stale active-workspace snapshot cannot recreate
    // a grant after the recipient's cleanup has completed.
    attachWorkspaceActivity(recipientWorkspaceId)
    const existing = currentByRecipient.get(recipientWorkspaceId)
    const status = selected.has(recipientWorkspaceId) ? "active" as const : "revoked" as const
    const onlyDuringUnlimited = conditional.has(recipientWorkspaceId)
    if (existing?.status === status && existing.onlyDuringUnlimited === onlyDuringUnlimited && existing.sourceGatewayModelId === model.gatewayModelId && existing.sourceProviderId === provider.id) continue
    writes.push({
      id: existing?.id || shareId(ownerWorkspaceId, model.id, recipientWorkspaceId),
      ownerWorkspaceId,
      recipientWorkspaceId,
      sourceProviderId: provider.id,
      sourceModelId: model.id,
      sourceGatewayModelId: model.gatewayModelId,
      status,
      onlyDuringUnlimited,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    })
  }
  await writeShares(writes)
  return listModelSharesForSourceModel(sourceModelId, ownerWorkspaceId)
}

export async function getSharedModelForRecipient(shareIdValue: string, recipientWorkspaceId = currentWorkspaceId()) {
  const share = (await readShares()).find((entry) => entry.id === shareIdValue)
  if (!share || share.recipientWorkspaceId !== recipientWorkspaceId) return undefined
  return viewFor(share, share.status === "active" ? await activeSource(share) : undefined)
}

export async function resolveSharedModelForRecipient(shareIdValue: string, recipientWorkspaceId = currentWorkspaceId()) {
  const share = (await readShares()).find((entry) => entry.id === shareIdValue)
  if (!share || share.recipientWorkspaceId !== recipientWorkspaceId || share.status !== "active") return undefined
  const source = await activeSource(share)
  if (!source || source.paused) return undefined
  return { share, ...source }
}

export function resetModelSharesForTests() { memoryShares().clear() }

export async function cleanupWorkspaceModelShares(workspaceId: string) {
  const shares = (await readShares()).filter(share => share.ownerWorkspaceId === workspaceId || share.recipientWorkspaceId === workspaceId)
  if (isMemoryBackend()) {
    for (const share of shares) memoryShares().delete(share.id)
  } else {
    const batch = db().batch()
    for (const share of shares) batch.delete(sharesRef().doc(share.id))
    await batch.commit()
  }
}
