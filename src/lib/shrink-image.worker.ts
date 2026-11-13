// The long edge a screenshot keeps so its text stays readable.
const LONG_EDGE = 2560;

async function encode(picture: ImageBitmap, scale: number, type: string, quality?: number): Promise<Blob | null> {
  const width = Math.max(1, Math.round(picture.width * scale));
  const height = Math.max(1, Math.round(picture.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  context.drawImage(picture, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type, quality });
  // Safari encodes an unknown type as PNG instead of failing
  return blob.type === type ? blob : null;
}

// null keeps the picture as a plain file
self.onmessage = async ({ data }: MessageEvent<{ file: Blob; maxBytes: number }>) => {
  let blob: Blob | null = null;
  try {
    const picture = await createImageBitmap(data.file);
    // a screenshot stays PNG while it fits; a photo, or a PNG still too big, goes lossy
    const tries: Array<[string, number?]> = data.file.type === "image/jpeg"
      ? [["image/jpeg", 0.9]]
      : [...(data.file.type === "image/png" ? [["image/png"] as [string]] : []), ["image/webp", 0.92], ["image/jpeg", 0.9]];
    let scale = Math.min(1, LONG_EDGE / Math.max(picture.width, picture.height));
    for (let round = 0; round < 6 && !blob; round++, scale *= 0.8) {
      for (const [type, quality] of tries) {
        const out = await encode(picture, scale, type, quality);
        if (out && out.size <= data.maxBytes) {
          blob = out;
          break;
        }
      }
    }
    picture.close();
  } catch {
    blob = null;
  }
  self.postMessage(blob);
};
