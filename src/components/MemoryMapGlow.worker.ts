import { render, type Source } from "./MemoryMapGlowPaint";

const scope = self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void };
self.onmessage = async ({ data }: MessageEvent<Source>) => {
  const { renderer, layers } = render(data);
  const bitmaps = layers && (await Promise.all(layers.map((each) => createImageBitmap(new ImageData(each.data, each.w, each.h)))));
  scope.postMessage({ renderer, layers: bitmaps }, bitmaps ?? []);
  self.close();
};
