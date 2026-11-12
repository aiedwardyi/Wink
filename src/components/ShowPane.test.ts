// @vitest-environment happy-dom
import { act, createElement } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VerifyCardData } from "../../shared/live-verify";
import { applyLocale } from "@/lib/i18n";
import { useRightSlot, type SlotPanel } from "@/lib/right-slot";
import { closeShow, showItem, useShowItem, type ShowItem } from "@/lib/show-pane";
import { closeVerifyWatch, openVerifyWatch, useVerifyWatch } from "@/lib/verify-watch";
import { ShowPane } from "./ShowPane";

const pdf = vi.hoisted(() => ({ pages: [] as number[] }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 8,
      getPage: async (n: number) => {
        pdf.pages.push(n);
        return { getViewport: ({ scale }: { scale: number }) => ({ width: 960 * scale, height: 540 * scale }), render: () => ({ promise: Promise.resolve(), cancel() {} }) };
      },
      destroy() {},
    }),
    destroy() {},
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card: VerifyCardData = { v: 1, runId: "run-1", owner: "bot", site: "luna/index.html", status: "completed", mode: "auto", decisionNonce: "n", offeredAt: Date.now(), startedAt: Date.now(), live: true, replay: [] };
const item = (path: string, kind: ShowItem["kind"]): ShowItem => ({ threadId: "t1", path, kind });
const src = (path: string) => `/api/threads/t1/linked-file?path=${encodeURIComponent(path)}`;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
  pdf.pages = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(null, { status: url.includes("linked-file") ? 206 : 404 })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); closeShow(); closeVerifyWatch(); applyLocale("en"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const render = (props: Parameters<typeof ShowPane>[0]) => act(async () => root.render(createElement(ShowPane, props)));
const until = async (done: () => boolean | undefined) => {
  for (let i = 0; i < 200 && !done(); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
};
const button = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

it("fits an image in the pane", async () => {
  await render({ item: item("C:\\w\\signups.png", "image"), hidden: false });
  const img = host.querySelector("img")!;
  expect(img.getAttribute("src")).toBe(src("C:\\w\\signups.png"));
  expect(host.querySelector(".show-frame-name")?.textContent).toBe("signups.png");
});

it("pages a PDF one page at a time", async () => {
  await render({ item: item("C:\\w\\launch-deck.pdf", "pdf"), hidden: false });
  await until(() => host.querySelector("[data-show-pager]")?.textContent?.includes("1 / 8"));
  expect(host.querySelector("[data-show-pager]")?.textContent).toContain("1 / 8");
  expect(button("Previous page")!.disabled).toBe(true);
  await act(async () => button("Next page")!.click());
  await until(() => host.querySelector("[data-show-pager]")?.textContent?.includes("2 / 8"));
  expect(host.querySelector("[data-show-pager]")?.textContent).toContain("2 / 8");
  expect(pdf.pages).toEqual([1, 2]);
});

it("shows a web page sandboxed, and Reload loads it again", async () => {
  await render({ item: item("C:\\w\\sync-flow.html", "page"), hidden: false });
  const frame = host.querySelector("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("src")).toBe(src("C:\\w\\sync-flow.html"));
  await act(async () => button("Reload")!.click());
  expect(host.querySelector("iframe")).not.toBe(frame);
});

it("hosts the checker with its Maximize and Close in the pane header", async () => {
  await render({ watch: { card, threadId: "t1", live: false }, hidden: false });
  expect(host.querySelector(".verify-watch-frame .verify-watch-bar")).not.toBeNull();
  expect(host.querySelectorAll('button[aria-label="Close"]')).toHaveLength(1);
  expect(host.querySelectorAll('button[aria-label="Maximize"]')).toHaveLength(1);
  expect(host.querySelector(".verify-watch-bar button[aria-label='Close']")).toBeNull();
  expect(host.querySelector("aside")!.hasAttribute("data-wide")).toBe(false);
  await act(async () => button("Maximize")!.click());
  expect(host.querySelector(".verify-watch-frame")!.hasAttribute("data-maximized")).toBe(true);
});

it("docks files wide and closes from the header", async () => {
  await act(async () => showItem(item("C:\\w\\a.png", "image")));
  await render({ item: item("C:\\w\\a.png", "image"), hidden: false });
  const aside = host.querySelector("aside")!;
  expect(aside.hasAttribute("data-wide")).toBe(true);
  expect(aside.classList.contains("animate-panel-in")).toBe(true);
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Show");
  await act(async () => button("Close")!.click());
  let shown: ShowItem | null = item("x", "image");
  function Probe() { shown = useShowItem(); return null; }
  await act(async () => root.render(createElement(Probe)));
  expect(shown).toBeNull();
});

it("collapses from the left like Bot details, on desktop only", async () => {
  await act(async () => showItem(item("C:\\w\\a.png", "image")));
  await render({ item: item("C:\\w\\a.png", "image"), hidden: false });
  const collapse = host.querySelector(".show-pane-head > button")!;
  expect(collapse.getAttribute("aria-label")).toBe("Collapse Show and Media");
  expect(collapse.getAttribute("title")).toBe("Collapse Show and Media");
  expect(button("Close")).not.toBeNull();
  await act(async () => (collapse as HTMLElement).click());
  let shown: ShowItem | null = item("x", "image");
  function Probe() { shown = useShowItem(); return null; }
  await act(async () => root.render(createElement(Probe)));
  expect(shown).toBeNull();
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  await render({ item: item("C:\\w\\a.png", "image"), hidden: false });
  expect(document.querySelector('button[aria-label="Collapse Show and Media"]')).toBeNull();
  expect(document.querySelector('button[aria-label="Close"]')).not.toBeNull();
});

it("speaks Korean", async () => {
  applyLocale("ko");
  await render({ item: item("C:\\w\\sync-flow.html", "page"), hidden: false });
  expect(host.querySelector('[role="tab"]')?.textContent).toBe("보기");
  expect(button("새로고침")).not.toBeNull();
  expect(button("닫기")).not.toBeNull();
  expect(button("보기와 미디어 접기")).not.toBeNull();
});

it("shares one spot with the checker", async () => {
  const seen: Array<[boolean, boolean]> = [];
  function Slot() {
    const watch = useVerifyWatch();
    const show = useShowItem();
    const panels: SlotPanel[] = [...(watch ? ["watch" as const] : []), ...(show ? ["show" as const] : [])];
    useRightSlot(panels, (panel) => panel === "watch" ? closeVerifyWatch() : closeShow());
    seen.push([Boolean(watch), Boolean(show)]);
    return null;
  }
  await act(async () => root.render(createElement(Slot)));
  await act(async () => openVerifyWatch({ threadId: "t1", owner: "bot", live: false }));
  await act(async () => showItem(item("C:\\w\\a.png", "image")));
  expect(seen.at(-1)).toEqual([false, true]);
  await act(async () => openVerifyWatch({ threadId: "t1", owner: "bot", live: false }));
  expect(seen.at(-1)).toEqual([true, false]);
  const app = readFileSync("src/App.tsx", "utf8");
  expect(app).toContain('panel === "show" ? closeShow()');
  expect(app).toContain('...(show || media ? ["show" as const] : [])');
});

it.each([["en", "Save a copy"], ["ko", "사본 저장"]] as const)("saves the shown file through the desktop dialog in %s", async (locale, label) => {
  applyLocale(locale);
  const saveFile = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "ogb", { configurable: true, value: { saveFile } });
  try {
    await render({ item: item("C:\\w\\cert.pdf", "pdf"), hidden: false });
    await act(async () => button(label)!.click());
    expect(saveFile).toHaveBeenCalledWith("C:\\w\\cert.pdf");
  } finally {
    Reflect.deleteProperty(window, "ogb");
  }
});

it("downloads the shown file in a browser", async () => {
  const saved: [string | null, string | null][] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push([this.getAttribute("href"), this.getAttribute("download")]); });
  await render({ item: item("C:\\w\\cert.pdf", "pdf"), hidden: false });
  await act(async () => button("Save a copy")!.click());
  expect(saved).toEqual([[src("C:\\w\\cert.pdf"), "cert.pdf"]]);
});

it("offers Open when the file can't be shown", async () => {
  const openFile = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "ogb", { configurable: true, value: { openFile } });
  try {
    await render({ item: item("C:\\w\\broken.png", "image"), hidden: false });
    await act(async () => { host.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Could not show this file");
    await act(async () => host.querySelector<HTMLButtonElement>("[data-show-fallback]")!.click());
    expect(openFile).toHaveBeenCalledWith("C:\\w\\broken.png");
  } finally {
    Reflect.deleteProperty(window, "ogb");
  }
});
