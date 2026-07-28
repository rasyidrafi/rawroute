import { redirect } from "next/navigation"

import { GatewayDashboard } from "@/components/gateway-dashboard"
import { isAuthenticated } from "@/lib/auth"
import { readData } from "@/lib/store"

export const dynamic = "force-dynamic"

export default async function Page() {
  if (!(await isAuthenticated())) redirect("/login")
  const data = await readData()
  return <GatewayDashboard initialState={{
    admin: { username: data.admin.username, mustChangePassword: data.admin.mustChangePassword },
    providers: data.providers.map((provider) => ({ ...provider, secret: provider.secret ? "__unchanged__" : "" })),
    models: data.models,
    apiKeys: data.apiKeys,
  }} />
}
