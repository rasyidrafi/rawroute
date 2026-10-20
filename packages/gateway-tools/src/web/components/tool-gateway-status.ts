import useSWR from "swr"

import { fetcher } from "@rawroute/platform/web/api"
import type { ToolGatewayStatus } from "../../contracts/index"

const statusEndpoint = "/api/admin/tool-gateway/status"

export function useToolGatewayStatus() {
  return useSWR<ToolGatewayStatus>(statusEndpoint, fetcher, {
    dedupingInterval: 10_000,
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    shouldRetryOnError: true,
  })
}
