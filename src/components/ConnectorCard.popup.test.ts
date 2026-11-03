// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

import { ConnectorCard } from "./ConnectorCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  applyLocale("en");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("says a blocked connection page in Korean", async () => {
  applyLocale("ko");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ url: "https://example.com/connect" })));
  vi.spyOn(window, "open").mockReturnValue(null);
  const message: Message = {
    id: "c1", role: "bot", kind: "connector", at: 1,
    connector: { slug: "gmail", label: "Gmail", description: "Read your mail", status: "required", resumeKey: "k1" },
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(ConnectorCard, { botId: "b1", threadId: "t1", message })));
  const connect = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("안전하게 연결"));
  await act(async () => connect!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await vi.waitFor(() => expect(host.textContent).toContain("브라우저가 연결 페이지를 막았어요"));
  expect(host.textContent).not.toContain("Your browser blocked");
  await act(async () => root.unmount());
  host.remove();
});
