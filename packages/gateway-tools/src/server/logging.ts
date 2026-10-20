import { createRecorder } from "@rawroute/observability/server/recorder"
import { serverEvents } from "./events"

export const toolsRecordLog = createRecorder(serverEvents)
