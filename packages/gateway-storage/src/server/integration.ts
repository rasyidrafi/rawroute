import { storageDocumentIntegration, validateStorageEncryption } from "./repository"
import { storageEnabled, storageEncryptionKey, storagePort } from "./config"
import { cleanupStorageWorkspace, recoverStorageMultiparts } from "./service"
import { startStorageListener } from "./listener"
import { storageRecordLog } from "./logging"
import { prepareStoragePersistence } from "./preparation"

let listener: Awaited<ReturnType<typeof startStorageListener>> | undefined
let recoveryPending = 0
export const storageServer = {
  preparePersistence: prepareStoragePersistence,
  documentIntegration: storageDocumentIntegration,
  deletionParticipant: { id: "storage", cleanup: cleanupStorageWorkspace },
  async start() {
    if (!storageEnabled() || listener) return
    storageEncryptionKey()
    if (storagePort() === Number(process.env.PORT || 3000)) throw new Error("Storage S3 and console ports must be different.")
    await validateStorageEncryption()
    recoveryPending = await recoverStorageMultiparts()
    if (recoveryPending) storageRecordLog("storage.recovery.pending", { count: recoveryPending }, { level: "warn" })
    listener = await startStorageListener({ port: storagePort(), hostname: process.env.STORAGE_S3_HOST || "0.0.0.0", region: "us-east-1" })
    storageRecordLog("storage.started")
  },
  async stop() { if (listener) { await listener.stop(); listener = undefined; storageRecordLog("storage.stopped") } },
  health() { return { enabled: storageEnabled(), listening: Boolean(listener), recoveryPending } },
}
