// @vitest-environment happy-dom
import { act, createElement } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VerifyCardData } from "../../shared/live-verify";
import { applyLocale } from "@/lib/i18n";
import { useRightSlot, type SlotPanel } from "@/lib/right-slot";
import { closeShow, showItem, useCheckThread, useShowItem, type ShowItem } from "@/lib/show-pane";
import { closeVerifyWatch, openVerifyWatch, toggleVerifyWatch, useVerifyWatch } from "@/lib/verify-watch";
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

it("speaks Korean", async () => {
  applyLocale("ko");
  await render({ item: item("C:\\w\\sync-flow.html", "page"), hidden: false });
  expect(host.querySelector('[role="tab"]')?.textContent).toBe("보기");
  expect(button("새로고침")).not.toBeNull();
  expect(button("닫기")).not.toBeNull();
});

it("shares one pane with the checker, and Bot Details still takes the spot", async () => {
  const seen: Array<[boolean, boolean]> = [];
  let details = false;
  function Slot() {
    const watch = useVerifyWatch();
    const show = useShowItem();
    const panels: SlotPanel[] = [...(watch || show ? ["show" as const] : []), ...(details ? ["details" as const] : [])];
    useRightSlot(panels, (panel) => { if (panel === "show") { closeVerifyWatch(); closeShow(); } else details = false; });
    seen.push([Boolean(watch), Boolean(show)]);
    return null;
  }
  await act(async () => root.render(createElement(Slot)));
  await act(async () => showItem(item("C:\\w\\a.png", "image")));
  await act(async () => openVerifyWatch({ threadId: "t1", owner: "bot", live: false }));
  expect(seen.at(-1)).toEqual([true, true]);
  details = true;
  await act(async () => root.render(createElement(Slot)));
  expect(seen.at(-1)).toEqual([false, false]);
  const app = readFileSync("src/App.tsx", "utf8");
  expect(app).toContain('...(watch || show || media ? ["show" as const] : [])');
});

const tabs = () => [...document.querySelectorAll(".show-pane-tabs [role='tab']")].map((tab) => tab.textContent);
const selected = () => host.querySelector(".show-pane-tabs [aria-selected='true']")?.textContent;
const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>(".show-pane-tabs [role='tab']")].find((el) => el.textContent === name)!;
const source = { threadId: "t1", messages: [], hasMore: false };
const probe = async (read: () => void) => {
  const box = createRoot(document.createElement("div"));
  function Probe() { read(); return null; }
  await act(async () => box.render(createElement(Probe)));
  act(() => box.unmount());
};

it("has no Check tab without a check", async () => {
  await render({ item: item("C:\\w\\a.png", "image"), source, hidden: false });
  expect(tabs()).toEqual(["Show", "Media"]);
});

it("the checker opens on Check, and Show keeps its file", async () => {
  const shown = item("C:\\w\\a.png", "image");
  await act(async () => showItem(shown));
  await act(async () => openVerifyWatch({ threadId: "t1", owner: "bot", live: false }));
  let check: string | null = null;
  await probe(() => { check = useCheckThread(); });
  expect(check).toBe("t1");
  await render({ item: shown, watch: { card, threadId: "t1", live: false }, check: true, source, hidden: false });
  expect(tabs()).toEqual(["Show", "Check", "Media"]);
  expect(selected()).toBe("Check");
  const aside = host.querySelector("aside")!;
  expect(aside.dataset.tab).toBe("check");
  expect(host.querySelector(".verify-watch-frame:not(.show-frame)")).not.toBeNull();
  expect(host.querySelector("img")?.getAttribute("src")).toBe(src("C:\\w\\a.png"));
});

it("switching tabs keeps the check alive and never reloads Show's file", async () => {
  const shown = item("C:\\w\\a.png", "image");
  await act(async () => showItem(shown));
  await act(async () => openVerifyWatch({ threadId: "t1", owner: "bot", live: false }));
  await render({ item: shown, watch: { card, threadId: "t1", live: false }, check: true, source, hidden: false });
  const img = host.querySelector("img")!;
  const checker = host.querySelector(".verify-watch-frame:not(.show-frame)")!;
  await act(async () => tab("Show").click());
  let check: string | null = "x";
  let watching = false;
  await probe(() => { check = useCheckThread(); watching = Boolean(useVerifyWatch()); });
  expect(check).toBeNull();
  expect(watching).toBe(true);
  await render({ item: shown, watch: { card, threadId: "t1", live: false }, source, hidden: false });
  expect(selected()).toBe("Show");
  expect(host.querySelector("aside")!.dataset.tab).toBe("show");
  expect(host.querySelector("img")).toBe(img);
  expect(host.querySelector(".verify-watch-frame:not(.show-frame)")).toBe(checker);
  await act(async () => tab("Check").click());
  await render({ item: shown, watch: { card, threadId: "t1", live: false }, check: true, source, hidden: false });
  expect(selected()).toBe("Check");
  expect(host.querySelector("img")).toBe(img);
  expect(host.querySelector(".verify-watch-frame:not(.show-frame)")).toBe(checker);
});

it("the Check tab opens the chat's finished check", async () => {
  const done = { ...card, live: undefined, replay: ["run-0"] };
  await render({ item: item("C:\\w\\a.png", "image"), card: done, source, hidden: false });
  expect(tabs()).toEqual(["Show", "Check", "Media"]);
  await act(async () => tab("Check").click());
  let watching: unknown = null;
  await probe(() => { watching = useVerifyWatch(); });
  expect(watching).toEqual({ threadId: "t1", owner: "bot", live: false });
});

it("the header checker button fronts Check, then closes it from there", async () => {
  await act(async () => showItem(item("C:\\w\\a.png", "image")));
  await act(async () => openVerifyWatch({ threadId: "t1", owner: "bot", live: false }));
  await act(async () => showItem(item("C:\\w\\a.png", "image")));
  let state: unknown[] = [];
  function Probe() { state = [useCheckThread(), Boolean(useVerifyWatch()), useShowItem()?.path]; return null; }
  await act(async () => root.render(createElement(Probe)));
  expect(state).toEqual([null, true, "C:\\w\\a.png"]);
  await act(async () => toggleVerifyWatch({ threadId: "t1", owner: "bot", live: false }));
  expect(state).toEqual(["t1", true, "C:\\w\\a.png"]);
  await act(async () => toggleVerifyWatch({ threadId: "t1", owner: "bot", live: false }));
  expect(state.slice(1)).toEqual([false, "C:\\w\\a.png"]);
});

it("speaks Korean on the Check tab", async () => {
  applyLocale("ko");
  await render({ watch: { card, threadId: "t1", live: false }, check: true, hidden: false });
  expect(selected()).toBe("검사");
});

it("hides only Show and Check behind the other tabs, never the Media list", () => {
  const css = readFileSync("src/components/ShowPane.css", "utf8");
  const rule = css.slice(css.indexOf(".show-pane:not([data-tab"), css.indexOf("{ display: none; }"));
  expect(rule).toContain('.show-pane:not([data-tab="check"]) > .verify-watch-frame:not(.show-frame, .show-media)');
});

it("a phone gets the Check tab for a running doc check, not a running site check", async () => {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} })));
  const running = { ...card, status: "running" as const, live: true as const, replay: [] };
  await render({ item: item("C:\w\a.png", "image"), card: running, source, hidden: false });
  expect(tabs()).toEqual(["Show", "Media"]);
  await render({ item: item("C:\w\a.png", "image"), card: { ...running, doc: { pages: 2, lines: 40, chunks: [0, 2] } }, source, hidden: false });
  expect(tabs()).toEqual(["Show", "Check", "Media"]);
});
