// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PeerMessageBody } from "./PeerMessage";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../styles.css"), "utf8");
const rule = (selector: RegExp) => selector.exec(css)?.[1] ?? "";

describe("Korean words stay whole", () => {
  it("the base stylesheet keeps Korean words whole and still breaks long unbroken text", () => {
    const base = rule(/html:lang\(ko\)\s*\{([^}]*)\}/);
    expect(base).toMatch(/word-break:\s*keep-all/);
    expect(base).toMatch(/overflow-wrap:\s*break-word/);
  });

  it("message text keeps them whole in every bubble, whatever the UI language", () => {
    const shared = rule(/^\[data-orbit-message-content\],\s*\[data-peer-body\]\s*\{([^}]*)\}/m);
    expect(shared).toMatch(/word-break:\s*keep-all/);
    expect(shared).toMatch(/overflow-wrap:\s*break-word/);
  });

  it("a sent or received bot message carries the attribute the shared rule styles", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(PeerMessageBody, { text: "공유하겠습니다" })));
      expect(host.querySelector("[data-peer-body]")?.textContent).toBe("공유하겠습니다");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
