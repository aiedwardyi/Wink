import type { TextCall } from "./memory-clean-types.ts";

export function callMemoryText(call: TextCall, prompt: string, opts: { timeoutMs: number; signal?: AbortSignal }): ReturnType<TextCall> {
  let cleanup = () => {};
  return new Promise<Awaited<ReturnType<TextCall>>>((resolve, reject) => {
    const abort = () => reject(opts.signal?.reason ?? new Error("Memory cleanup aborted"));
    const timer = setTimeout(() => reject(new Error("Memory cleanup text timed out")), opts.timeoutMs);
    cleanup = () => { clearTimeout(timer); opts.signal?.removeEventListener("abort", abort); };
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) { abort(); cleanup(); return; }
    Promise.resolve().then(() => {
      opts.signal?.throwIfAborted();
      return call(prompt, opts);
    }).then(resolve, reject);
  }).finally(() => cleanup());
}
