// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyLocale } from "@/lib/i18n";
import { saveSidebarSide } from "@/lib/sidebar-preferences";
import { closeShow, showItem, useMediaThread, useShowItem } from "@/lib/show-pane";
import { closeVerifyWatch, openVerifyWatch, useVerifyWatch } from "@/lib/verify-watch";
import { ShowPaneButton } from "./ShowPaneButton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
let state: unknown[] = [];

function Probe({ threadId }: { threadId: string }) {
  state = [useShowItem()?.path ?? null, useMediaThread(), Boolean(useVerifyWatch())];
  return createElement(ShowPaneButton, { threadId });
}

beforeEach(() => {
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); act(() => { closeShow(); closeVerifyWatch(); }); applyLocale("en"); saveSidebarSide("left"); });

const render = (threadId: string) => act(async () => root.render(createElement(Probe, { threadId })));
const press = () => act(async () => host.querySelector("button")!.click());

it.each(["left", "right"] as const)("opens Media, then closes, with the bot list on the %s", async (side) => {
  saveSidebarSide(side);
  await render("b1");
  const button = host.querySelector("button")!;
  expect(button.textContent).toBe("");
  expect(button.title).toBe("Show and media");
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(button.querySelector("svg")!.classList.contains("lucide-panel-right-open")).toBe(true);
  expect(button.querySelector("svg")!.getAttribute("width")).toBe("18");
  expect(button.querySelector("svg")!.getAttribute("stroke-width")).toBe("2");
  await press();
  expect(state).toEqual([null, "b1", false]);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.querySelector("svg")!.classList.contains("lucide-panel-right-close")).toBe(true);
  await press();
  expect(state).toEqual([null, null, false]);
  expect(button.querySelector("svg")!.classList.contains("lucide-panel-right-open")).toBe(true);
});

it("opens Show when this chat has shown a file", async () => {
  await render("b2");
  await act(async () => showItem({ threadId: "b2", path: "C:\\w\\a.png", kind: "image" }));
  expect(host.querySelector(".lucide-panel-right-close")).not.toBeNull();
  await act(async () => closeShow());
  await press();
  expect(state).toEqual(["C:\\w\\a.png", null, false]);
});

it("closes the checker when it holds the pane", async () => {
  await render("b3");
  await act(async () => openVerifyWatch({ threadId: "b3", owner: "bot", live: false }));
  expect(host.querySelector("button")!.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector(".lucide-panel-right-close")).not.toBeNull();
  await press();
  expect(state).toEqual([null, null, false]);
});

it("speaks Korean", async () => {
  applyLocale("ko");
  await render("b4");
  expect(host.querySelector("button")!.title).toBe("보기와 미디어");
});
