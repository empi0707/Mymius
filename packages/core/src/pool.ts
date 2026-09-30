/** Run `worker` over `items` with bounded concurrency. Errors are the worker's business. */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  let next = 0
  const lanes = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < items.length) {
        if (signal?.aborted) return
        const i = next++
        await worker(items[i] as T, i)
      }
    })
  )
}
