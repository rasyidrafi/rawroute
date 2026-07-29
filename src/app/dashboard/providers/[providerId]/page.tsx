import { GatewayDashboard } from "@/components/gateway-dashboard"

export default async function Page({ params }: PageProps<"/dashboard/providers/[providerId]">) {
  const { providerId } = await params
  return <GatewayDashboard view="provider-detail" providerId={providerId} />
}
