// A picture too big for an engine to take inline also goes as a smaller copy,
// made in a worker so typing never waits on a 4K decode.
export function shrinkImage(file: Blob, maxBytes: number): Promise<Blob | null> {
  if (!("Worker" in globalThis) || !("OffscreenCanvas" in globalThis)) return Promise.resolve(null);
  const worker = new Worker(new URL("./shrink-image.worker.ts", import.meta.url), { type: "module" });
  return new Promise<Blob | null>((resolve) => {
    worker.onmessage = ({ data }: MessageEvent<Blob | null>) => resolve(data);
    worker.onerror = () => resolve(null);
    worker.postMessage({ file, maxBytes });
  }).finally(() => worker.terminate());
}
