// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FileAttachmentRow } from "./FileAttachmentRow";

const row = (path: string, threadId?: string, preview?: string) =>
  renderToStaticMarkup(createElement(FileAttachmentRow, { file: { path, name: path.split("\\").pop()!, size: 13958958, preview }, threadId }));

describe("file attachment row", () => {
  it("shows a picture's thumbnail as a button that opens it", () => {
    const html = row("C:\\Users\\me\\Downloads\\Wink\\image (3).png", "t1");
    expect(html).toMatch(/^<button[^>]*data-file-row/);
    expect(html).toContain(`<img src="/api/threads/t1/linked-file?path=${encodeURIComponent("C:\\Users\\me\\Downloads\\Wink\\image (3).png")}"`);
    expect(html).toContain("13.3 MB");
  });

  it("prefers the saved smaller copy", () => {
    expect(row("C:\\pics\\big.png", "t1", "C:\\data\\attachments\\0f0e-small.webp")).toContain('<img src="/api/attachments/0f0e-small.webp"');
  });

  it("loads a picture saved in the attachment store from the store", () => {
    expect(row("C:\\Users\\me\\.orbit\\attachments\\0f0e0d0c-0b0a-4000-8000-000000000001.png", "t1")).toContain('<img src="/api/attachments/0f0e0d0c-0b0a-4000-8000-000000000001.png"');
  });

  it("keeps the plain row for other files and without a chat", () => {
    for (const html of [row("C:\\docs\\plan.pdf", "t1"), row("C:\\pics\\big.png")]) {
      expect(html).toMatch(/^<div[^>]*data-file-row/);
      expect(html).not.toContain("<img");
    }
  });
});
