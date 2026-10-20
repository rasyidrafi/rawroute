import { PublicPageLayout } from "@rawroute/platform/web/public-page-layout"
import { aiPagePaths, publicUsageRoutes } from "../contracts/pages"
import { PublicPage, PublicKeyUsagePage } from "./views"
import { UsageSkeleton } from "./components/usage-skeleton"
import { KeyUsageSkeleton } from "./components/key-usage-skeleton"

export const aiPublicRoutes = [
  { id: "publicDashboard", path: aiPagePaths.home, title: "Public usage", owner: "ai", app: "public", scope: "workspace", view: <PublicPage />, skeleton: <PublicPageLayout loading><UsageSkeleton /></PublicPageLayout> },
  { id: "publicKeyUsage", path: publicUsageRoutes.keyUsage, title: "Public key usage", owner: "ai", app: "public", scope: "workspace", view: <PublicKeyUsagePage />, skeleton: <PublicPageLayout loading><KeyUsageSkeleton /></PublicPageLayout> },
] as const
