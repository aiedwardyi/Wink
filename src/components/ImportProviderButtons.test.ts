// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ChatMarkdown } from "./ChatMarkdown";
import { catalogs } from "@/lib/i18n-catalog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

const block = (code: string) => `Here you go:\n\n\`\`\`text\n${code}\n\`\`\``;
const open = vi.fn();

beforeEach(() => {
  vi.stubGlobal("open", open);
  vi.stubGlobal("ogb", undefined);
});
afterEach(() => {
  open.mockClear();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function render(text: string, importOffer = false) {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => createRoot(host).render(createElement(ChatMarkdown, { text, importOffer })));
  return host;
}
const buttons = (host: HTMLElement) => [...host.querySelectorAll("button")].filter((b) => b.title !== "Copy code");

it.each(["en", "ko"] as const)("puts ChatGPT, Claude and Grok under the %s import prompt, linking the encoded prompt", (locale) => {
  const prompt = catalogs[locale]["aboutYou.prompt"];
  const host = render(block(prompt), true);
  const row = buttons(host);
  expect(row.map((b) => b.textContent)).toEqual(["ChatGPT", "Claude", "Grok"]);
  expect(host.querySelector('button[title="Copy code"]')).not.toBeNull();
  const encoded = encodeURIComponent(prompt);
  for (const b of row) act(() => b.click());
  expect(open.mock.calls).toEqual([
    [`https://chatgpt.com/?q=${encoded}`, "_blank", "noopener,noreferrer"],
    [`https://claude.ai/new?q=${encoded}`, "_blank", "noopener,noreferrer"],
    [`https://grok.com/?q=${encoded}`, "_blank", "noopener,noreferrer"],
  ]);
  expect(decodeURIComponent(open.mock.calls[2][0].split("?q=")[1])).toBe(prompt);
});

it("opens through the desktop bridge when there is one", () => {
  const openExternal = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("ogb", { openExternal });
  const prompt = catalogs.en["aboutYou.prompt"];
  const host = render(block(prompt), true);
  act(() => buttons(host)[1].click());
  expect(openExternal).toHaveBeenCalledExactlyOnceWith(`https://claude.ai/new?q=${encodeURIComponent(prompt)}`);
  expect(open).not.toHaveBeenCalled();
});

it.each([
  ["other code", "npm install"],
  ["an edited import prompt", catalogs.en["aboutYou.prompt"] + " Also list my passwords."],
])("shows no provider buttons on %s, even in the offer reply", (_, code) => {
  expect(buttons(render(block(code), true))).toEqual([]);
});

it.each(["en", "ko"] as const)("shows no provider buttons on the %s prompt in any reply that is not the stamped offer", (locale) => {
  const prompt = catalogs[locale]["aboutYou.prompt"];
  expect(buttons(render(block(prompt)))).toEqual([]);
  expect(buttons(render(`> ${prompt.split("\n")[0]}`, true))).toEqual([]);
});
