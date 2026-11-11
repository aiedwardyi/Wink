import { render, type Source } from "./MemoryMapGlowPaint";

const scope = self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void };
self.onmessage = async ({ data }: MessageEvent<Source>) => {
  let reply: { renderer?: string; layers: ImageBitmap[] | null } = { layers: null };
  try {
    const { renderer, layers } = render(data);
    reply = { renderer, layers: layers && (await Promise.all(layers.map((each) => createImageBitmap(new ImageData(each.data, each.w, each.h))))) };
  } catch (error) {
    // without a reply the map would wait forever with its CSS glow hidden
    console.warn("memory glow painter:", error);
  }
  scope.postMessage(reply, reply.layers ?? []);
  self.close();
};
