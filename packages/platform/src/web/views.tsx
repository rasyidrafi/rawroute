import { lazy } from "react"

const SettingsView = lazy(() => import("./settings-view").then(module => ({ default: module.SettingsView })))
export const platformViews = { settings: <SettingsView /> }
