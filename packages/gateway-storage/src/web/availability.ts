import useSWR from "swr"
import { fetcher } from "@rawroute/platform/web/api"
import type { StorageAvailabilityStatus } from "../contracts"

const statusEndpoint = "/api/admin/storage/status"

export function useStorageStatus() {
  return useSWR<StorageAvailabilityStatus>(statusEndpoint, fetcher, {
    dedupingInterval: 10_000,
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    shouldRetryOnError: true,
  })
}

export function useStorageAvailability() {
  const { data, error } = useStorageStatus()
  const state = error ? "unavailable" : data?.state || "checking"
  return {
    available: state === "available",
    statusLabel: state === "checking" ? "Checking" : state === "disabled" ? "Not configured" : state === "unavailable" ? "Unavailable" : "",
  }
}
