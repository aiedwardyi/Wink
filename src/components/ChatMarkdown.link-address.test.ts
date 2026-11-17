// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ChatMarkdown } from "./ChatMarkdown";

// SAFETY: React reads this flag off globalThis at act() time; the DOM lib does not declare it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

const render = (text: string, props: { localLinks?: boolean } = {}) => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(ChatMarkdown, { text, ...props })));
  return host;
};

describe("chat link address", () => {
  it.each([
    ["a normal link", "https://example.com/docs"],
    ["a long link", `https://example.com/${"segment/".repeat(40)}end?q=${"a".repeat(200)}#frag`],
    ["an escaped link", "https://example.com/a%20b/%E2%9C%93?x=1%262&y=%22q%22"],
  ])("shows %s's real address as its tooltip", (_, url) => {
    const link = render(`[label](${url})`).querySelector("a")!;
    expect(link.getAttribute("href")).toBe(url);
    expect(link.getAttribute("title")).toBe(url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });

  it("shows the address of an autolinked bare url", () => {
    expect(render("see https://example.com/x now").querySelector("a")?.getAttribute("title")).toBe("https://example.com/x");
  });

  it("keeps an unsafe protocol from becoming a link", () => {
    expect(render("[x](javascript:alert(1))").querySelector("a")).toBeNull();
  });

  it("leaves a linked file's tooltip as its path", () => {
    const host = render("[notes](C:/work/notes.md)", { localLinks: true });
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector("[title='C:/work/notes.md']")).not.toBeNull();
  });
});
