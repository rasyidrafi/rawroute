import { createRecorder } from "@rawroute/observability/server/recorder"
export const storageRecordLog = createRecorder({
  "storage.started": { source: "storage", message: "Storage S3 listener started." },
  "storage.stopped": { source: "storage", message: "Storage S3 listener stopped." },
  "storage.recovery.pending": { source: "storage", message: "Storage multipart recovery requires attention." },
  "storage.request.failed": { source: "storage", message: "Storage S3 request failed." },
  "storage.request.completed": { source: "storage", message: "Storage S3 request completed." },
})
