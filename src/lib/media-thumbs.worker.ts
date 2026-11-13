async function picture(src: string): Promise<ImageBitmap | null> {
  const res = await fetch(src);
  return res.ok ? createImageBitmap(await res.blob()) : null;
}

// null sends the cell back to the picture itself
self.onmessage = async ({ data }: MessageEvent<{ id: number; src: string; size: number; frame?: VideoFrame | ImageBitmap }>) => {
  let blob: Blob | null = null;
  try {
    const full = data.frame ? await createImageBitmap(data.frame) : await picture(data.src);
    if (full) {
      const side = Math.min(full.width, full.height);
      const size = Math.min(data.size, side);
      const square = await createImageBitmap(full, Math.floor((full.width - side) / 2), Math.floor((full.height - side) / 2), side, side, { resizeWidth: size, resizeHeight: size, resizeQuality: "medium" });
      full.close();
      const canvas = new OffscreenCanvas(size, size);
      canvas.getContext("2d")!.drawImage(square, 0, 0);
      square.close();
      blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
    }
  } catch {
    blob = null;
  } finally {
    data.frame?.close();
  }
  self.postMessage({ id: data.id, blob });
};
