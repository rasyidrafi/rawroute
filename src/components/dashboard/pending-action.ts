import type { Dispatch, SetStateAction } from "react"

export async function withPendingAction<T>(pendingKey: string, setPending: Dispatch<SetStateAction<Set<string>>>, action: () => Promise<T>, onError: (error: unknown) => void): Promise<T | undefined> {
  setPending((current) => new Set(current).add(pendingKey))
  try {
    return await action()
  } catch (error) {
    onError(error)
    return undefined
  } finally {
    setPending((current) => {
      const next = new Set(current)
      next.delete(pendingKey)
      return next
    })
  }
}
