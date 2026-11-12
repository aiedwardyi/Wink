import type { SyntheticEvent } from "react";
import { describe, expect, it } from "vitest";
import { chatImageBox, rememberChatImage } from "./chat-image";

const load = (src: string, w = 100, h = 50) => rememberChatImage({
  currentTarget: { getAttribute: () => src, naturalWidth: w, naturalHeight: h, offsetWidth: 0, clientWidth: 0 },
} as unknown as SyntheticEvent<HTMLImageElement>);

describe("chat image sizes", () => {
  it("forgets the least recently used size past 300 images", () => {
    for (let i = 0; i < 300; i++) load(`/api/attachments/${i}.png`);
    chatImageBox("/api/attachments/0.png");
    load("/api/attachments/300.png");
    expect(chatImageBox("/api/attachments/0.png")?.width).toBe(100);
    expect(chatImageBox("/api/attachments/1.png")?.width).toBeUndefined();
    expect(chatImageBox("/api/attachments/300.png")?.width).toBe(100);
  });

  it("never keys a size on inline image data", () => {
    const src = `data:image/png;base64,${"A".repeat(4096)}`;
    load(src);
    expect(chatImageBox(src)?.width).toBeUndefined();
  });
});
