import useSWR from "swr"

export function useSession() {
  return useSWR<{ authenticated: boolean }>("/api/auth/session", async (url: string) => {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error("Unable to check your session. Please retry.")
    const session: unknown = await response.json()
    if (!session || typeof session !== "object" || !("authenticated" in session) || typeof session.authenticated !== "boolean") {
      throw new Error("Invalid session response. Please retry.")
    }
    return { authenticated: session.authenticated }
  }, { revalidateOnFocus: true, dedupingInterval: 2_000, errorRetryCount: 3, errorRetryInterval: 5_000 })
}
