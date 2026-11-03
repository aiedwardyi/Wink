// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { applyLocale } from "@/lib/i18n";

import { ReplyQuote } from "./ReplyQuote";
import type { Message } from "@/state/store";

describe("ReplyQuote", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  afterEach(() => {
    root.unmount();
    host.remove();
    applyLocale("en");
  });

  it("strips pasted-text wrapper tags from the reply quote snippet", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const raw = '<pasted-text index="1">\nquoted message text\n</pasted-text>';
    const message: Message = { id: "m1", role: "user", kind: "text", text: raw, at: 1 };

    await act(async () => {
      root.render(createElement(ReplyQuote, { message }));
    });

    expect(host.textContent).not.toContain("<pasted-text");
    expect(host.textContent).toContain("quoted message text");
  });

  it("labels the reply, jump and cancel controls in Korean", async () => {
    applyLocale("ko");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const message: Message = { id: "m1", role: "bot", kind: "text", text: "hello", at: 1, from: { botId: "b1", name: "Wink", color: "blue" } };

    await act(async () => {
      root.render(createElement(ReplyQuote, { message, onJump: () => {}, onClear: () => {} }));
    });

    expect(host.textContent).toContain("Wink에게 답장 중");
    expect(host.textContent).not.toContain("Replying to");
    expect(host.querySelector("button[title]")?.getAttribute("title")).toBe("원본 메시지로 이동");
    expect(host.querySelector("button[aria-label]")?.getAttribute("aria-label")).toBe("답장 취소");
  });
});
