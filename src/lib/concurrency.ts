/** Keep in-flight work bounded and settle it before returning or throwing. */
export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError("Concurrency must be a positive integer.")
  const output = new Array<R>(items.length)
  let nextIndex = 0
  let failed = false
  let failure: unknown

  async function runNext(): Promise<void> {
    if (failed || nextIndex >= items.length) return
    const index = nextIndex++
    try {
      output[index] = await mapper(items[index], index)
    } catch (error) {
      if (!failed) failure = error
      failed = true
      return
    }
    return runNext()
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext))
  if (failed) throw failure
  return output
}
