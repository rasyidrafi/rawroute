import { lazy } from "react"

const ConsoleLog = lazy(() => import("./console-log").then(module => ({ default: module.ConsoleLog })))
const SystemLogs = lazy(() => import("./console-log").then(module => ({ default: module.SystemLogs })))
export const observabilityViews = { logs: <ConsoleLog />, systemLogs: <SystemLogs /> }
