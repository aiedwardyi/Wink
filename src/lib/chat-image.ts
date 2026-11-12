import type { CSSProperties, SyntheticEvent } from "react";

// keep in step with CHAT_IMAGE: max-h-96 is 384px, 32rem is 512px
const MAX_W = 512;
const MAX_H = 384;

// a wrapper needs it too: fit-content sizing ignores the image's percentage max-width
export const CHAT_IMAGE = "max-h-96 max-w-[min(32rem,100%)]";

const sizes = new Map<string, { w: number; h: number; border: number }>();

export function chatImageBox(src: string | undefined): CSSProperties | undefined {
  const size = src ? sizes.get(src) : undefined;
  if (!size) return undefined;
  const { w, h, border } = size;
  return { width: Math.min(w, MAX_W - border, ((MAX_H - border) * w) / h) + border, aspectRatio: `auto ${w} / ${h}` };
}

export function rememberChatImage(event: SyntheticEvent<HTMLImageElement>) {
  const img = event.currentTarget;
  const src = img.getAttribute("src");
  if (src && img.naturalWidth && img.naturalHeight) sizes.set(src, { w: img.naturalWidth, h: img.naturalHeight, border: img.offsetWidth - img.clientWidth });
}
