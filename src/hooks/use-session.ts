import useSWR from "swr"

export function useSession() {
  return useSWR<{ authenticated: boolean }>("/api/auth/session", async (url: string) => {
    const response = await fetch(url, { cache: "no-store" })
    if (!response.ok) throw new Error("Unable to check your session. Please retry.")
    return response.json()
  }, { revalidateOnFocus: true, dedupingInterval: 0 })
}
