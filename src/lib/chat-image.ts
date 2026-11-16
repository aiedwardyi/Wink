import type { CSSProperties, SyntheticEvent } from "react";

const MAX_W = 512;
const MAX_H = 384;
const MAX_SIZES = 300;

// a wrapper needs it too: fit-content sizing ignores the image's percentage max-width
export const CHAT_IMAGE: CSSProperties = { maxHeight: MAX_H, maxWidth: `min(${MAX_W}px, 100%)` };

const sizes = new Map<string, { w: number; h: number; border: number }>();

export function chatImageBox(src: string | undefined): CSSProperties {
  const size = src ? sizes.get(src) : undefined;
  if (!src || !size) return CHAT_IMAGE;
  sizes.delete(src);
  sizes.set(src, size);
  const { w, h, border } = size;
  return { ...CHAT_IMAGE, width: Math.min(w, MAX_W - border, ((MAX_H - border) * w) / h) + border, aspectRatio: `auto ${w} / ${h}` };
}

export function rememberChatImage(event: SyntheticEvent<HTMLImageElement>) {
  const img = event.currentTarget;
  const src = img.getAttribute("src");
  if (!src || src.startsWith("data:") || !img.naturalWidth || !img.naturalHeight) return;
  sizes.delete(src);
  sizes.set(src, { w: img.naturalWidth, h: img.naturalHeight, border: img.offsetWidth - img.clientWidth });
  const oldest = sizes.keys().next().value;
  if (sizes.size > MAX_SIZES && oldest !== undefined) sizes.delete(oldest);
}
