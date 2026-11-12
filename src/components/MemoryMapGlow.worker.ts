import { painter, render, type Source } from "./MemoryMapGlowPaint";

const scope = self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void };
// null warms the context and shader ahead of the first open, and gets no answer
self.onmessage = async ({ data }: MessageEvent<Source | null>) => {
  if (!data) return void painter();
  let reply: { renderer?: string; layers: ImageBitmap[] | null } = { layers: null };
  try {
    const { renderer, layers } = render(data);
    reply = { renderer, layers: layers && (await Promise.all(layers.map((each) => createImageBitmap(new ImageData(each.data, each.w, each.h))))) };
  } catch (error) {
    // without a reply the map would wait forever with its CSS glow hidden
    console.warn("memory glow painter:", error);
  }
  scope.postMessage(reply, reply.layers ?? []);
};
