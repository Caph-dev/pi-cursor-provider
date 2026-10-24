const CANCELLED = "Cursor sign-in cancelled"

export function sleep(
  ms: number,
  signal?: AbortSignal,
  onAbort: "reject" | "resolve" = "reject",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      if (onAbort === "resolve") resolve()
      else reject(new Error(CANCELLED))
    }
    if (signal?.aborted) {
      cancel()
      return
    }
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      fn()
    }
    const abort = () => finish(cancel)
    const timer = setTimeout(() => finish(resolve), ms)
    signal?.addEventListener("abort", abort)
  })
}
