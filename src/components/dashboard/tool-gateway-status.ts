"use client"

import useSWR from "swr"

import { fetcher } from "@/components/dashboard/api"
import type { ToolGatewayStatus } from "@/lib/types"

const statusEndpoint = "/api/admin/tool-gateway/status"

export function useToolGatewayStatus() {
  return useSWR<ToolGatewayStatus>(statusEndpoint, fetcher, {
    dedupingInterval: 10_000,
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    shouldRetryOnError: true,
  })
}
