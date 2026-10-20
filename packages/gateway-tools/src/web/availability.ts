import { useToolGatewayStatus } from "./components/tool-gateway-status"

export function useToolsAvailability() {
  const { data } = useToolGatewayStatus()
  return { available: data?.state === "available", statusLabel: !data ? "Checking" : data.state === "disabled" ? "Not configured" : "Unavailable" }
}
