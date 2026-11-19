// @vitest-environment happy-dom
import { act, createElement } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VerifyCardData } from "../../shared/live-verify";
import { applyLocale } from "@/lib/i18n";
import { noteMemoryFrame } from "@/lib/memory-clean-events";
import { useRightSlot, type SlotPanel } from "@/lib/right-slot";
import { closeShow, showItem, showMap, useCheckThread, useShowItem, type ShowItem } from "@/lib/show-pane";
import { closeVerifyWatch, openVerifyWatch, toggleVerifyWatch, useVerifyWatch } from "@/lib/verify-watch";
import { applyPicks, parseTimeline } from "../../server/picks";
import { ShowPane } from "./ShowPane";

const pdf = vi.hoisted(() => ({ pages: [] as number[], broken: [] as number[], params: undefined as unknown, gate: Promise.resolve() }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: (params: unknown) => (pdf.params = params, {
    promise: pdf.gate.then(() => ({
      numPages: 8,
      getPage: async (n: number) => {
        pdf.pages.push(n);
        if (pdf.broken.includes(n)) throw new Error("bad page");
        return { getViewport: ({ scale }: { scale: number }) => ({ width: 960 * scale, height: 540 * scale }), render: () => ({ promise: Promise.resolve(), cancel() {} }) };
      },
      destroy() {},
    })),
    destroy() {},
  }),
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/pdf.worker.min.mjs" }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card: VerifyCardData = { v: 1, runId: "run-1", owner: "bot", site: "luna/index.html", status: "completed", mode: "auto", decisionNonce: "n", offeredAt: Date.now(), startedAt: Date.now(), live: true, replay: [] };
const item = (path: string, kind: ShowItem["kind"]): ShowItem => ({ threadId: "t1", path, kind });
const src = (path: string) => `/api/threads/t1/linked-file?path=${encodeURIComponent(path)}`;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
  pdf.pages = [];
  pdf.broken = [];
  pdf.gate = Promise.resolve();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const response = new Response(null, { status: url.includes("linked-file") ? 206 : 404 });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }));
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

it("puts the desktop pane toggle after Maximize in the pane header", async () => {
  const shown = item("C:\\w\\a.png", "image");
  await act(async () => showItem(shown));
  await render({ item: shown, source: { threadId: "t1", messages: [] }, hidden: false });
  const head = host.querySelector(".show-pane-head")!;
  const toggle = head.querySelector<HTMLButtonElement>("[data-show-pane-button]");
  expect(toggle).not.toBeNull();
  expect(toggle?.previousElementSibling?.getAttribute("aria-label")).toBe("Maximize");
  expect(toggle?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => toggle?.click());
  expect(host.querySelector("[data-show-pane-button]")?.getAttribute("aria-pressed")).toBe("false");
});

it("fits an image in the pane", async () => {
  await render({ item: item("C:\\w\\signups.png", "image"), hidden: false });
  const img = host.querySelector("img")!;
  expect(img.getAttribute("src")).toBe(src("C:\\w\\signups.png"));
  expect(host.querySelector(".show-frame-name")?.textContent).toBe("signups.png");
});

it("shows a text file as text", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response("test4\n<b>line two</b>", { status: 200 }));
  await render({ item: item("C:\\w\\test.txt", "text"), hidden: false });
  await until(() => Boolean(host.querySelector(".show-stage[data-ready] pre")));
  const pre = host.querySelector(".show-stage[data-ready] pre")!;
  expect(pre.textContent).toBe("test4\n<b>line two</b>");
  expect(pre.children).toHaveLength(0);
  expect(fetch).toHaveBeenCalledWith(src("C:\\w\\test.txt"));
  expect(host.querySelector(".show-frame")!.getAttribute("data-kind")).toBe("text");
  expect(host.querySelector(".show-frame-name")?.textContent).toBe("test.txt");
});

it.each([
  ["an announced size", () => new Response("x", { status: 200, headers: { "content-length": "1000001" } })],
  ["no announced size", () => new Response("x".repeat(1_000_001), { status: 200 })],
])("offers Open for a text file too big for the pane, with %s", async (_, reply) => {
  vi.mocked(fetch).mockResolvedValue(reply());
  await render({ item: item("C:\\w\\huge.txt", "text"), hidden: false });
  await until(() => Boolean(host.querySelector("[data-show-fallback]")));
  expect(host.querySelector("[data-show-fallback]")).not.toBeNull();
  expect(host.querySelector("pre")).toBeNull();
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

it("says a page it could not draw could not be shown, not a blank or stale page", async () => {
  pdf.broken = [2];
  await render({ item: item("C:\\w\\launch-deck.pdf", "pdf"), hidden: false });
  await until(() => host.querySelector("[data-show-pager]")?.textContent?.includes("1 / 8"));
  await act(async () => button("Next page")!.click());
  await until(() => host.textContent?.includes("Could not show this file"));
  expect(host.textContent).toContain("Could not show this file");
  expect(host.querySelector("canvas.show-pdf")).toBeNull();
});

let clock = 0;
const touch = (type: string, points: [number, number][], target: Element = host.querySelector("canvas.show-pdf")!, dt = 40) => {
  clock += dt;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { touches: { value: type === "touchend" || type === "touchcancel" ? [] : points.map(([clientX, clientY]) => ({ clientX, clientY })) }, timeStamp: { value: clock } });
  return act(async () => { target.dispatchEvent(event); });
};
const swipe = async (from: [number, number], to: [number, number]) => {
  await touch("touchstart", [from], undefined, 400);
  await touch("touchmove", [[(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]]);
  await touch("touchmove", [to]);
  await touch("touchend", []);
};
const counter = () => host.querySelector("[data-show-pager]")?.textContent;

it("turns the PDF page with a horizontal swipe, and stops at either end", async () => {
  await render({ item: item("C:\\w\\launch-deck.pdf", "pdf"), hidden: false });
  await until(() => counter()?.includes("1 / 8"));
  await swipe([100, 300], [300, 300]);
  expect(counter()).toContain("1 / 8");
  await swipe([300, 300], [100, 300]);
  await until(() => counter()?.includes("2 / 8"));
  expect(counter()).toContain("2 / 8");
  await swipe([100, 300], [300, 300]);
  await until(() => counter()?.includes("1 / 8"));
  expect(counter()).toContain("1 / 8");
  expect(pdf.pages).toEqual([1, 2, 1]);
  for (let n = 0; n < 9; n++) await swipe([300, 300], [100, 300]);
  await until(() => counter()?.includes("8 / 8"));
  expect(counter()).toContain("8 / 8");
});

it("ignores a swipe while the PDF is still loading", async () => {
  let open = () => {};
  pdf.gate = new Promise<void>((resolve) => { open = resolve; });
  await render({ item: item("C:\\w\\launch-deck.pdf", "pdf"), hidden: false });
  await swipe([300, 300], [100, 300]);
  await swipe([100, 300], [300, 300]);
  await act(async () => open());
  await until(() => counter()?.includes("1 / 8"));
  expect(counter()).toContain("1 / 8");
  expect(pdf.pages).toEqual([1]);
});

it("leaves a vertical drag and a two finger pinch to the browser", async () => {
  await render({ item: item("C:\\w\\launch-deck.pdf", "pdf"), hidden: false });
  await until(() => counter()?.includes("1 / 8"));
  await swipe([200, 100], [220, 500]);
  await touch("touchstart", [[100, 300], [300, 300]], undefined, 400);
  await touch("touchmove", [[20, 300], [380, 300]]);
  await touch("touchend", []);
  expect(counter()).toContain("1 / 8");
  expect(pdf.pages).toEqual([1]);
});

it("keeps the chat swipe off the PDF page", async () => {
  await render({ item: item("C:\\w\\launch-deck.pdf", "pdf"), hidden: false });
  expect(host.querySelector("canvas.show-pdf")!.closest("[data-no-swipe]")).not.toBeNull();
});

it("loads a PDF with the shipped CMaps, so fonts that are not embedded still draw Korean", async () => {
  await render({ item: item("C:\\w\\견적서.pdf", "pdf"), hidden: false });
  await until(() => Boolean(pdf.params));
  expect(pdf.params).toMatchObject({ cMapUrl: "/pdfjs/cmaps/", cMapPacked: true });
});

it("shows a web page sandboxed, and Reload loads it again", async () => {
  await render({ item: item("C:\\w\\sync-flow.html", "page"), hidden: false });
  const frame = host.querySelector("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("src")).toBe(src("C:\\w\\sync-flow.html"));
  await act(async () => button("Reload")!.click());
  expect(host.querySelector("iframe")).not.toBe(frame);
});

it("loads the page grant resolved by the authenticated app, without giving its frame a token", async () => {
  const granted = "http://localhost:8799/api/threads/t1/linked-file/page/grant/";
  const response = new Response(null, { status: 206 });
  Object.defineProperty(response, "url", { value: granted });
  vi.mocked(fetch).mockResolvedValue(response);
  await render({ item: item("C:\\w\\diffmap.html", "page"), hidden: false });
  expect(fetch).toHaveBeenCalledWith(src("C:\\w\\diffmap.html"), { headers: { Range: "bytes=0-0" } });
  expect(host.querySelector("iframe")?.getAttribute("src")).toBe(granted);
  expect(host.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
});

it("waits for a page grant before navigating the sandboxed frame", async () => {
  vi.mocked(fetch).mockReturnValue(new Promise(() => {}));
  await render({ item: item("C:\\w\\diffmap.html", "page"), hidden: false });
  expect(host.querySelector("iframe")).toBeNull();
});

it("renews the page grant on Reload", async () => {
  const response = (url: string) => Object.defineProperty(new Response(null, { status: 200 }), "url", { value: url });
  vi.mocked(fetch).mockResolvedValueOnce(response("/api/threads/t1/linked-file/page/first/"));
  await render({ item: item("C:\\w\\diffmap.html", "page"), hidden: false });
  vi.mocked(fetch).mockResolvedValueOnce(response("/api/threads/t1/linked-file/page/renewed/"));
  await act(async () => button("Reload")!.click());
  expect(host.querySelector("iframe")?.getAttribute("src")).toBe("/api/threads/t1/linked-file/page/renewed/");
});

it.each(["missing", "offline"])("offers Open instead of navigating a %s page", async (failure) => {
  if (failure === "missing") vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));
  else vi.mocked(fetch).mockRejectedValue(new Error("offline"));
  await render({ item: item("C:\\w\\diffmap.html", "page"), hidden: false });
  expect(host.querySelector("iframe")).toBeNull();
  expect(host.querySelector("[data-show-fallback]")).not.toBeNull();
});

it("hosts the checker with its Maximize and pane toggle in the header", async () => {
  await render({ watch: { card, threadId: "t1", live: false }, hidden: false });
  expect(host.querySelector(".verify-watch-frame .verify-watch-bar")).not.toBeNull();
  expect(host.querySelectorAll(".show-pane-head [data-show-pane-button]")).toHaveLength(1);
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
  expect(aside.classList.contains("md:animate-panel-slide")).toBe(true);
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Show");
  await act(async () => host.querySelector<HTMLButtonElement>(".show-pane-head [data-show-pane-button]")!.click());
  let shown: ShowItem | null = item("x", "image");
  function Probe() { shown = useShowItem(); return null; }
  await act(async () => root.render(createElement(Probe)));
  expect(shown).toBeNull();
});

it.each([false, true])("closes from the far right of the header, phone %s", async (phone) => {
  vi.stubGlobal("matchMedia", () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }));
  await act(async () => showItem(item("C:\\w\\a.png", "image")));
  await render({ item: item("C:\\w\\a.png", "image"), hidden: false });
  const head = document.querySelector(".show-pane-head")!;
  const buttons = [...head.querySelectorAll<HTMLButtonElement>(":scope > button")];
  expect(buttons.map((each) => each.getAttribute("aria-label"))).toEqual(phone ? ["Close"] : ["Maximize", "Show and media"]);
  expect(head.lastElementChild).toBe(buttons.at(-1));
  expect(head.querySelector(".lucide-chevron-right")).toBeNull();
  await act(async () => buttons.at(-1)!.click());
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
  expect(button("보기와 미디어")).not.toBeNull();
  expect(host.querySelectorAll(".show-pane-head > button")).toHaveLength(2);
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
  expect(app).toContain('...(watch || show || media || mapping || crewThread || timelineThread ? ["show" as const] : [])');
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
  await render({ item: item("C:\\w\\a.png", "image"), source, botId: "b1", hidden: false });
  expect(tabs()).toEqual(["Show", "Media", "Map", "Timeline"]);
});

it("renders the Map tab in Korean with the surrounding labels", async () => {
  await act(async () => applyLocale("ko"));
  await render({ item: item("C:\\w\\a.png", "image"), source, botId: "b1", hidden: false });
  expect(tabs()).toEqual(["보기", "미디어", "맵", "타임라인"]);
});

it("the checker opens on Check, and Show keeps its file", async () => {
  const shown = item("C:\\w\\a.png", "image");
  await act(async () => showItem(shown));
  await act(async () => openVerifyWatch({ threadId: "t1", owner: "bot", live: false }));
  let check: string | null = null;
  await probe(() => { check = useCheckThread(); });
  expect(check).toBe("t1");
  await render({ item: shown, watch: { card, threadId: "t1", live: false }, check: true, source, botId: "b1", hidden: false });
  expect(tabs()).toEqual(["Show", "Media", "Check", "Map", "Timeline"]);
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
  await render({ item: shown, watch: { card, threadId: "t1", live: false }, check: true, source, botId: "b1", hidden: false });
  const img = host.querySelector("img")!;
  const checker = host.querySelector(".verify-watch-frame:not(.show-frame)")!;
  await act(async () => tab("Show").click());
  let check: string | null = "x";
  let watching = false;
  await probe(() => { check = useCheckThread(); watching = Boolean(useVerifyWatch()); });
  expect(check).toBeNull();
  expect(watching).toBe(true);
  await render({ item: shown, watch: { card, threadId: "t1", live: false }, source, botId: "b1", hidden: false });
  expect(selected()).toBe("Show");
  expect(host.querySelector("aside")!.dataset.tab).toBe("show");
  expect(host.querySelector("img")).toBe(img);
  expect(host.querySelector(".verify-watch-frame:not(.show-frame)")).toBe(checker);
  await act(async () => tab("Check").click());
  await render({ item: shown, watch: { card, threadId: "t1", live: false }, check: true, source, botId: "b1", hidden: false });
  expect(selected()).toBe("Check");
  expect(host.querySelector("img")).toBe(img);
  expect(host.querySelector(".verify-watch-frame:not(.show-frame)")).toBe(checker);
});

it("the Check tab opens the chat's finished check", async () => {
  const done = { ...card, live: undefined, replay: ["run-0"] };
  await render({ item: item("C:\\w\\a.png", "image"), card: done, source, botId: "b1", hidden: false });
  expect(tabs()).toEqual(["Show", "Media", "Check", "Map", "Timeline"]);
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
  expect(rule).toContain('.show-pane:not([data-tab="check"]) > .verify-watch-frame:not(.show-frame, .show-media, .map-pane, .show-workers, .timeline-pane)');
});

it("keeps Maximize and Close in the pane: tabs scroll instead of growing the row, and the sheet starts under the Windows caption", () => {
  const css = readFileSync("src/components/ShowPane.css", "utf8");
  const row = css.match(/^\.show-pane-tabs \{[^}]*\}/m)![0];
  expect(row).toContain("min-width: 0");
  expect(row).toContain("overflow-x: auto");
  expect(css).toMatch(/\.show-pane-tabs button \{[^}]*flex-shrink: 0[^}]*white-space: nowrap[^}]*outline-offset: -2px/);
  expect(css).toContain('html[data-orbit-caption="win32"] .verify-watch.show-pane { top: var(--orbit-caption-height); }');
});

it("the tab row never scrolls up and down: the phone tap area hangs past the buttons and would lift the selected pill off center", () => {
  const css = readFileSync("src/components/ShowPane.css", "utf8");
  expect(css).toMatch(/^\.show-pane-tabs \{[^}]*overflow-y: (hidden|clip)/m);
});

it("a phone gets the Check tab for a running doc check, not a running site check", async () => {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} })));
  const running = { ...card, status: "running" as const, live: true as const, replay: [] };
  await render({ item: item("C:\\w\\a.png", "image"), card: running, source, botId: "b1", hidden: false });
  expect(tabs()).toEqual(["Show", "Media", "Map", "Timeline"]);
  await render({ item: item("C:\\w\\a.png", "image"), card: { ...running, doc: { pages: 2, lines: 40, chunks: [0, 2] } }, source, botId: "b1", hidden: false });
  expect(tabs()).toEqual(["Show", "Media", "Check", "Map", "Timeline"]);
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

const settle = (name: string) => act(async () => { host.querySelector("aside")!.dispatchEvent(Object.assign(new Event("animationend", { bubbles: true }), { animationName: name })); });
const lit = () => host.querySelector("aside")!.classList.contains("arrival-glow");

it("pulses the pane once when its file is clicked again, and not when a click only switches to it", async () => {
  const shown = item("C:\\w\\timeline-mock.html", "page");
  await render({ item: shown, hidden: false });
  await act(async () => showItem(shown));
  expect(lit()).toBe(false);
  await act(async () => showItem(shown));
  expect(lit()).toBe(true);
  expect(host.querySelectorAll("iframe")).toHaveLength(1);
  await settle("panel-slide");
  expect(lit()).toBe(true);
  await settle("arrival-glow-once");
  expect(lit()).toBe(false);
  await act(async () => showMap("t1"));
  await act(async () => showItem(shown));
  expect(lit()).toBe(false);
});

const timeline = readFileSync("test/fixtures/decision-timeline/decisions.md", "utf8");
const picks = (reply: () => Response) => vi.mocked(fetch).mockImplementation(async (url) => (String(url).endsWith("/memory/topics/decisions.md") ? reply() : new Response(null, { status: 404 })));
// each test names its own bot: a replaced pick's fold and the search are kept for the session, per bot
const openTimeline = (botId = "b1", closing = false) => render({ timeline: true, profileName: "Edward", botId, source: { threadId: "t1", messages: [] }, hidden: false, closing });
const picked = () => [...host.querySelectorAll<HTMLElement>("[data-timeline-pick]:not([data-old])")];
const named = (key: string) => picked().find((pick) => pick.querySelector(".timeline-key")?.textContent === key)!;
const strokes = (kind: string) => host.querySelectorAll(`.timeline-ink path[data-ink="${kind}"]`).length;
const pickList = () => picks(() => new Response(JSON.stringify({ name: "decisions.md", text: timeline, entries: parseTimeline(timeline).entries }), { status: 200 }));
const type = (input: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

it("draws the bot's picks on the Timeline canvas, newest day first, each pick circled and the rest struck, a replaced pick folded under the newer one", async () => {
  pickList();
  await openTimeline("b-canvas");
  const tab = [...host.querySelectorAll(".show-pane-tabs [role=tab]")].find((each) => each.textContent === "Timeline");
  expect(tab?.getAttribute("aria-selected")).toBe("true");
  await until(() => picked().length > 0);
  expect([...host.querySelectorAll("[data-timeline-day]")].map((day) => day.getAttribute("data-timeline-day"))).toEqual(["2026-11-17", "2026-11-14"]);
  expect(picked().map((pick) => pick.querySelector(".timeline-key")?.textContent)).toEqual(["Timeline place", "Model Index on phone", "Forum look", "Map on phone", "Speed board look"]);
  const forum = named("Forum look");
  expect(forum.querySelector("[data-won] .timeline-caption")?.textContent).toBe("Reddit-style list (mock 2)");
  expect([...forum.querySelectorAll("[data-timeline-out]")].map((out) => out.textContent)).toEqual(["A - Needs you header", "B - Needs you chip"]);
  expect(named("Timeline place").querySelector("[data-won] .timeline-pic")?.textContent).toBe("Tab in the side pane");
  const outs = host.querySelectorAll("[data-timeline-out]").length;
  expect(outs).toBe(10);
  expect(strokes("ring")).toBe(2 * 5);
  expect(strokes("strike")).toBe(2 * outs);
  expect(strokes("link")).toBe(4);
  expect(strokes("replaced")).toBe(0);
  const fold = forum.querySelector<HTMLButtonElement>("[data-timeline-replaced]")!;
  expect(fold.textContent).toBe("Replaced pick · 11:05 · Bot to bot, like Reddit");
  expect(host.textContent).not.toContain("i thot this is bot to bot forum");
  await act(async () => fold.click());
  const old = host.querySelector<HTMLElement>("[data-timeline-pick][data-old]")!;
  expect(old.querySelector(".timeline-key")?.textContent).toBe("Bot to bot, like Reddit");
  expect(old.textContent).toContain("i thot this is bot to bot forum, not me?");
  expect(old.querySelector(".timeline-said span")?.textContent).toMatch(/^Edward · /);
  expect(old.querySelector(".timeline-label time")?.textContent).toMatch(/^replaced · (?:2026-)?11-17 11:18$/);
  expect(strokes("replaced")).toBe(1);
  expect(strokes("route")).toBe(1);
  expect([...forum.querySelectorAll(".timeline-tweaks q")].map((tweak) => tweak.textContent)).toEqual(["im wondering if it should have a small title up top so ppl know what it is", "humans can reply too if they want, but its made for the bots"]);
  expect(host.querySelector(".timeline-hint")?.textContent).toMatch(/^Scroll to move · Ctrl\+scroll to zoom\d+%$/);
  const search = host.querySelector<HTMLInputElement>(".timeline-search input")!;
  expect(search.placeholder).toBe("Search picks and your words");
  await type(search, "reddit");
  expect(picked().map((pick) => pick.querySelector(".timeline-key")?.textContent)).toEqual(["Forum look"]);
});

it("pairs a crossed picture by its caption, and an uncaptioned one only with the option left over", async () => {
  const text = "# Decision timeline\n\n## 2026-11-17 10:00 | Header look | current\n- Picked: C - big title\n- Over: A - no title; B - small title\n- Over pictures: C:\\Users\\me\\.orbit\\attachments\\b.png (B - small title); C:\\Users\\me\\.orbit\\attachments\\a.png\n";
  picks(() => new Response(JSON.stringify({ name: "decisions.md", text, entries: parseTimeline(text).entries }), { status: 200 }));
  await openTimeline("b-pair");
  await until(() => picked().length > 0);
  expect([...picked()[0]!.querySelectorAll("[data-timeline-out]")].map((out) => [out.textContent, out.querySelector("img")?.getAttribute("src")?.split("/").pop()])).toEqual([["A - no title", "a.png"], ["B - small title", "b.png"]]);
});

it("loads a room pick's own file through the room it was picked in", async () => {
  const text = "# Decision timeline\n\n## 2026-11-17 10:00 | Header look | current\n- Picked: C - big title\n- Picture: C:\\w\\c.png (C - big title)\n- Over: A - no title\n- Over pictures: C:\\w\\a.png (A - no title)\n- Files: C:\\w\\shot.png\n- Thread: room1\n";
  picks(() => new Response(JSON.stringify({ name: "decisions.md", text, entries: parseTimeline(text).entries }), { status: 200 }));
  await openTimeline("b-room");
  await until(() => picked().length > 0);
  expect([...picked()[0]!.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual(
    ["C:\\w\\a.png", "C:\\w\\c.png", "C:\\w\\shot.png"].map((path) => `/api/threads/room1/linked-file?path=${encodeURIComponent(path)}`),
  );
});

it("keeps the search text and an open replaced pick after a tab switch and back", async () => {
  pickList();
  await openTimeline("b-switch");
  await until(() => host.querySelector(".timeline-search input") !== null);
  await type(host.querySelector<HTMLInputElement>(".timeline-search input")!, "forum");
  await act(async () => host.querySelector<HTMLButtonElement>("[data-timeline-replaced]")!.click());
  await render({ item: item("C:\\w\\a.png", "image"), hidden: false });
  expect(host.querySelector(".timeline-pane")).toBeNull();
  await openTimeline("b-switch");
  await until(() => host.querySelector(".timeline-search input") !== null);
  expect(host.querySelector<HTMLInputElement>(".timeline-search input")!.value).toBe("forum");
  expect(host.querySelector("[data-timeline-replaced]")?.getAttribute("aria-expanded")).toBe("true");
});

it("opens on the newest pick again after panning, reopening, and clearing search", async () => {
  pickList();
  const newestAtStart = () => {
    expect(picked()[0]?.querySelector(".timeline-key")?.textContent).toBe("Timeline place");
    expect(host.querySelector<HTMLElement>(".timeline-sheet")?.style.transform).toBe("translate(4px, 44px) scale(0.86)");
  };
  await openTimeline("b-reopen");
  await until(() => picked().length > 0);
  newestAtStart();
  await act(async () => {
    host.querySelector(".timeline-canvas")!.dispatchEvent(Object.defineProperties(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 500 }), { ctrlKey: { value: false } }));
  });
  expect(host.querySelector<HTMLElement>(".timeline-sheet")?.style.transform).toBe("translate(4px, -456px) scale(0.86)");
  await render({ item: item("C:\\w\\a.png", "image"), hidden: false });
  expect(host.querySelector(".timeline-canvas")).toBeNull();
  await openTimeline("b-reopen");
  await until(() => picked().length > 0);
  newestAtStart();

  const search = host.querySelector<HTMLInputElement>(".timeline-search input")!;
  await type(search, "speed board");
  expect(picked()[0]?.querySelector(".timeline-key")?.textContent).toBe("Speed board look");
  await act(async () => {
    host.querySelector(".timeline-canvas")!.dispatchEvent(Object.defineProperties(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 }), { ctrlKey: { value: true }, clientX: { value: 0 }, clientY: { value: 0 } }));
  });
  expect(host.querySelector(".timeline-hint b")?.textContent).toBe("110%");
  await type(search, "");
  newestAtStart();
});

it("returns to the newest pick if reopened before the pane finishes closing", async () => {
  pickList();
  await openTimeline("b-reopen-during-exit");
  await until(() => picked().length > 0);
  const sheet = host.querySelector<HTMLElement>(".timeline-sheet")!;
  await act(async () => {
    host.querySelector(".timeline-canvas")!.dispatchEvent(Object.defineProperties(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 500 }), { ctrlKey: { value: false } }));
  });
  await openTimeline("b-reopen-during-exit", true);
  expect(sheet.style.transform).toBe("translate(4px, -456px) scale(0.86)");
  await openTimeline("b-reopen-during-exit");
  expect(sheet.style.transform).toBe("translate(4px, 44px) scale(0.86)");
});

it("orders days and picks by the current pick, even when a newer tap lost to it", async () => {
  const text = `# Decision timeline

## 2026-11-14 10:00 | Old choice | current
- Picked: A

## 2026-11-17 09:00 | Morning choice | current
- Picked: A

## 2026-11-17 10:00 | Latest choice | current
- Picked: B
- At: ${new Date(2026, 10, 17, 10, 0, 35).getTime()}

## 2026-11-17 10:00 (2) | Earlier choice | current
- Picked: A
- At: ${new Date(2026, 10, 17, 10, 0, 15).getTime()}

## 2026-11-18 10:00 | Old choice | replaced by 2026-11-14 10:00
- Picked: B
- Tapped: yes
`;
  picks(() => new Response(JSON.stringify({ entries: parseTimeline(text).entries }), { status: 200 }));
  await openTimeline("b-order");
  await until(() => picked().length > 0);
  expect([...host.querySelectorAll("[data-timeline-day]")].map((day) => day.getAttribute("data-timeline-day"))).toEqual(["2026-11-17", "2026-11-14"]);
  expect(picked().map((pick) => pick.querySelector(".timeline-key")?.textContent)).toEqual(["Latest choice", "Earlier choice", "Morning choice", "Old choice"]);
});

it("opens with the retyped pick at its latest action time even when its heading still dates the tap", async () => {
  for (const day of [17, 18]) {
    const pick = (key: string, messageId: string, date: number, hour: number, tapped = false) => ({
      kind: "pick" as const, key, messageId, questionId: `${key}-question`, thread: "t1", at: new Date(2026, 10, date, hour).getTime(),
      picked: "B - blue cards", said: "I choose B", tapped,
    });
    const text = applyPicks("", [pick("Forum", "m1", 17, 10, true), pick("Settings", "m2", 17, 11), pick("Forum", "m3", day, 12)])!.text;
    expect(text).toContain("## 2026-11-17 10:00 | Forum | current");
    picks(() => new Response(JSON.stringify({ entries: parseTimeline(text).entries }), { status: 200 }));
    await openTimeline(`b-retyped-${day}`);
    await until(() => named("Forum")?.querySelector("q")?.textContent === "I choose B" && picked().length === 2);
    expect(picked().map((row) => row.querySelector(".timeline-key")?.textContent)).toEqual(["Forum", "Settings"]);
    expect(named("Forum").closest("section")?.querySelector("[data-timeline-day]")?.getAttribute("data-timeline-day")).toBe(`2026-11-${day}`);
    expect(named("Forum").querySelector("time")?.textContent).toContain("12:00");
    expect(named("Forum").querySelector(".timeline-said span")?.textContent).toContain("12:00");
    await render({ hidden: true });
  }
});

it("shows the text of an unbound pick without printing its heading time", async () => {
  const text = '# Decision timeline\n\n## 2026-11-17 10:00 | Forum | current\n- Picked: B - blue cards\n- Said: "I choose B"\n- Binding: unbound\n';
  picks(() => new Response(JSON.stringify({ entries: parseTimeline(text).entries }), { status: 200 }));
  await openTimeline("b-unbound");
  await until(() => picked().length === 1);
  expect(named("Forum").querySelector("[data-won]")?.textContent).toBe("B - blue cards");
  expect(named("Forum").querySelector(".timeline-said span")?.textContent).toBe("Edward");
  expect(named("Forum").querySelector("time, img")).toBeNull();
  expect([...host.querySelectorAll("[data-timeline-day]")].map((day) => day.getAttribute("data-timeline-day"))).toEqual(["2026-11-17"]);
});

it("sorts a text-only pick by its day, above an older day's timed pick", async () => {
  const text = '# Decision timeline\n\n## 2026-11-14 10:00 | Header | current\n- Picked: A - small\n\n## 2026-11-17 | Forum | current\n- Picked: B - blue cards\n- Said: "I choose B"\n- Binding: unbound\n';
  picks(() => new Response(JSON.stringify({ entries: parseTimeline(text).entries }), { status: 200 }));
  await openTimeline("b-unbound-day");
  await until(() => picked().length === 2);
  expect(picked().map((pick) => pick.querySelector(".timeline-key")?.textContent)).toEqual(["Forum", "Header"]);
  expect([...host.querySelectorAll("[data-timeline-day]")].map((day) => day.getAttribute("data-timeline-day"))).toEqual(["2026-11-17", "2026-11-14"]);
  expect(named("Forum").querySelector("time")).toBeNull();
});

it("moves with scroll and a drag, zooms with Ctrl+scroll and a pinch, and shows the zoom in the corner", async () => {
  pickList();
  await openTimeline("b-move");
  await until(() => picked().length > 0);
  const canvas = host.querySelector<HTMLElement>(".timeline-canvas")!;
  const sheet = () => host.querySelector<HTMLElement>(".timeline-sheet")!.style.transform;
  const zoom = () => host.querySelector(".timeline-hint b")?.textContent;
  expect(sheet()).toBe("translate(4px, 44px) scale(0.86)");
  expect(zoom()).toBe("86%");
  // happy-dom's WheelEvent drops its modifier keys and point
  const wheel = (init: WheelEventInit) => act(async () => {
    canvas.dispatchEvent(Object.defineProperties(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }), { ctrlKey: { value: init.ctrlKey ?? false }, clientX: { value: 0 }, clientY: { value: 0 } }));
  });
  await wheel({ deltaY: 100 });
  expect(sheet()).toBe("translate(4px, -56px) scale(0.86)");
  await wheel({ deltaY: -100, ctrlKey: true });
  expect(zoom()).toBe("110%");
  const pointer = (kind: string, x: number, y: number, pointerId = 1) => canvas.dispatchEvent(new PointerEvent(kind, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, pointerId, pointerType: "touch" }));
  const scale = () => Number(/scale\(([\d.]+)\)/.exec(sheet())![1]);
  const before = scale();
  await act(async () => { pointer("pointerdown", 100, 100); pointer("pointermove", 102, 101); });
  expect(scale()).toBe(before);
  const still = sheet();
  await act(async () => { pointer("pointermove", 160, 140); pointer("pointerup", 160, 140); });
  expect(sheet()).not.toBe(still);
  await act(async () => { pointer("pointerdown", 100, 200, 1); pointer("pointerdown", 200, 200, 2); pointer("pointermove", 50, 200, 1); pointer("pointermove", 250, 200, 2); pointer("pointerup", 50, 200, 1); pointer("pointerup", 250, 200, 2); });
  expect(scale()).toBeGreaterThan(before * 1.5);
  const open = named("Map on phone").querySelector<HTMLButtonElement>("[data-won] button")!;
  await act(async () => { pointer("pointerdown", 10, 10); pointer("pointermove", 80, 80); pointer("pointerup", 80, 80); open.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); });
  expect(document.querySelector("[data-media-viewer]")).toBeNull();
});

it("keeps a pinch's move at the canvas edge, and moves the canvas with the arrow keys", async () => {
  pickList();
  await openTimeline("b-edge");
  await until(() => picked().length > 0);
  const canvas = host.querySelector<HTMLElement>(".timeline-canvas")!;
  const sheet = host.querySelector<HTMLElement>(".timeline-sheet")!;
  Object.defineProperties(canvas, { clientWidth: { value: 400 }, clientHeight: { value: 600 } });
  Object.defineProperties(sheet, { offsetWidth: { value: 1000 }, offsetHeight: { value: 2000 } });
  const view = () => /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(sheet.style.transform)!.slice(1).map(Number);
  expect(view()).toEqual([4, 44, 0.86]);
  const pointer = (kind: string, x: number, pointerId: number) => canvas.dispatchEvent(new PointerEvent(kind, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 200, pointerId, pointerType: "touch" }));
  await act(async () => { pointer("pointerdown", 100, 1); pointer("pointerdown", 200, 2); pointer("pointermove", 260, 2); pointer("pointerup", 100, 1); pointer("pointerup", 260, 2); });
  const [x, y, scale] = view();
  expect(scale).toBeCloseTo(1.376);
  expect(x).toBeCloseTo(180 - (180 - 34) * 1.6);
  expect(y).toBeCloseTo(200 - (200 - 44) * 1.6);
  const label = named("Forum look").querySelector<HTMLElement>("[data-label]")!;
  await act(async () => { label.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
  expect(view()[0]).toBeCloseTo(x - 40);
  await act(async () => { label.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
  expect(view()[1]).toBeCloseTo(y - 40);
});

it("draws the newest picks first and the rest a batch a frame", async () => {
  const many = "# Decision timeline\n\n" + Array.from({ length: 40 }, (_, i) => `## 2026-10-${String(1 + (i % 28)).padStart(2, "0")} ${10 + Math.floor(i / 28)}:00 | Question ${i} | current\n- Picked: A${i}\n- Over: B${i}\n`).join("\n");
  picks(() => new Response(JSON.stringify({ name: "decisions.md", text: many, entries: parseTimeline(many).entries }), { status: 200 }));
  const frames: FrameRequestCallback[] = [];
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => frames.push(frame));
  await openTimeline("b-many");
  await until(() => picked().length > 0);
  expect(picked().length).toBe(8);
  expect(picked()[0].querySelector(".timeline-key")?.textContent).toBe("Question 27");
  const sheet = host.querySelector(".timeline-sheet")!;
  expect(sheet.querySelector(".timeline-day")?.textContent).toBe("Newest");
  expect(sheet.lastElementChild?.className).not.toBe("timeline-day");
  while (frames.length) await act(async () => frames.shift()!(0));
  expect(picked().length).toBe(40);
  expect(sheet.lastElementChild?.className).toBe("timeline-day");
  expect(sheet.lastElementChild?.textContent).toBe("Oldest");
  raf.mockRestore();
});

it("starts a new search at the top, even after one with no results", async () => {
  pickList();
  await openTimeline("b-stale");
  await until(() => picked().length > 0);
  const canvas = host.querySelector<HTMLElement>(".timeline-canvas")!;
  await act(async () => {
    canvas.dispatchEvent(Object.defineProperties(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 }), { ctrlKey: { value: false }, clientX: { value: 0 }, clientY: { value: 0 } }));
  });
  expect(host.querySelector<HTMLElement>(".timeline-sheet")!.style.transform).toBe("translate(4px, -56px) scale(0.86)");
  const search = host.querySelector<HTMLInputElement>(".timeline-pane input")!;
  await type(search, "zzzz");
  expect(host.querySelector(".timeline-canvas")).toBeNull();
  await type(search, "reddit");
  await until(() => picked().length > 0);
  expect(host.querySelector<HTMLElement>(".timeline-sheet")!.style.transform).toBe("translate(4px, 44px) scale(0.86)");
});

it("gives every pick a keyboard stop, and a mouse let go outside the canvas does not drag on its way back", async () => {
  pickList();
  await openTimeline("b-keys");
  await until(() => picked().length > 0);
  expect(picked().map((pick) => pick.querySelector<HTMLElement>("[data-label]")!.tabIndex)).toEqual(picked().map(() => 0));
  const canvas = host.querySelector<HTMLElement>(".timeline-canvas")!;
  const sheet = () => host.querySelector<HTMLElement>(".timeline-sheet")!.style.transform;
  const before = sheet();
  await act(async () => {
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 1, pointerType: "mouse" }));
    canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, button: -1, buttons: 0, clientX: 180, clientY: 160, pointerId: 1, pointerType: "mouse" }));
    canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, button: -1, buttons: 0, clientX: 220, clientY: 200, pointerId: 1, pointerType: "mouse" }));
  });
  expect(sheet()).toBe(before);
});

it("stops a fling at the sheet's edges", async () => {
  pickList();
  await openTimeline("b-edge");
  await until(() => picked().length > 0);
  const canvas = host.querySelector<HTMLElement>(".timeline-canvas")!;
  const sheet = host.querySelector<HTMLElement>(".timeline-sheet")!;
  Object.defineProperties(canvas, { clientWidth: { value: 300 }, clientHeight: { value: 600 } });
  Object.defineProperties(sheet, { offsetWidth: { value: 500 }, offsetHeight: { value: 1000 } });
  const wheel = (deltaY: number) => act(async () => {
    canvas.dispatchEvent(Object.defineProperties(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY }), { ctrlKey: { value: false }, clientX: { value: 0 }, clientY: { value: 0 } }));
  });
  await wheel(5000);
  expect(sheet.style.transform).toBe("translate(4px, -260px) scale(0.86)");
  await wheel(-9000);
  expect(sheet.style.transform).toBe("translate(4px, 44px) scale(0.86)");
});

it("opens a screenshot, or a picked or crossed picture, in the viewer on one click", async () => {
  pickList();
  await openTimeline("b-viewer");
  await until(() => picked().length > 0);
  const opener = (selector: string) => named("Map on phone").querySelector<HTMLButtonElement>(selector)!;
  expect(document.querySelector("[data-media-viewer]")).toBeNull();
  for (const [selector, name] of [[".timeline-shots button", "map-shot1.png"], ["[data-won] button", "map-pick.png"], ["[data-timeline-out] button", "map-a2.png"]] as const) {
    expect(opener(selector).getAttribute("aria-label")).toBe(`Open Image ${name}`);
    await act(async () => opener(selector).click());
    expect(document.querySelector("[data-media-viewer] img")?.getAttribute("src")).toContain(name);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await until(() => !document.querySelector("[data-media-viewer]"));
    expect(document.querySelector("[data-media-viewer]")).toBeNull();
  }
});

it("consumes Escape when it closes the Timeline, so a card behind it stays", async () => {
  pickList();
  await openTimeline("b-esc");
  await until(() => picked().length > 0);
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => { window.dispatchEvent(escape); });
  expect(escape.defaultPrevented).toBe(true);
});

const press = (key: string) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
const viewed = () => document.querySelector("[data-media-viewer] img")?.getAttribute("src") ?? "";
const thumb = (button?: HTMLElement) => button!.querySelector("img")!.getAttribute("src")!;

it("moves to the next and previous picture of the same pick with the arrow keys", async () => {
  pickList();
  await openTimeline("b-arrows");
  await until(() => picked().length > 0);
  const [first, second] = [...named("Map on phone").querySelectorAll<HTMLButtonElement>("button.timeline-open")];
  await act(async () => first!.click());
  expect(viewed()).toBe(thumb(first));
  await press("ArrowLeft");
  expect(viewed()).toBe(thumb(first));
  await press("ArrowRight");
  expect(viewed()).toBe(thumb(second));
  await press("ArrowLeft");
  expect(viewed()).toBe(thumb(first));
});

it("steps through the same attachment in the winner and the screenshots", async () => {
  const entries = [{ id: "2026-11-18", key: "Mock layout", picked: "A", picture: { path: "/attachments/A.png" }, over: [], overPictures: [], files: ["/attachments/A.png", "/attachments/B.png"], tweaks: [] }];
  picks(() => new Response(JSON.stringify({ entries }), { status: 200 }));
  await openTimeline("b-duplicate-pictures");
  await until(() => picked().length > 0);
  const [winner, screenshot] = [...picked()[0]!.querySelectorAll<HTMLButtonElement>("button.timeline-open")];
  await act(async () => winner!.click());
  await press("ArrowRight");
  expect(viewed()).toContain("A.png");
  await press("ArrowRight");
  expect(viewed()).toContain("B.png");
  await press("ArrowLeft");
  expect(viewed()).toContain("A.png");
  await act(async () => screenshot!.click());
  await press("ArrowRight");
  expect(viewed()).toContain("B.png");
});

it("leaves right-click on a picture to the image's own menu, with nothing drawn over it", async () => {
  pickList();
  await openTimeline("b-menu");
  await until(() => picked().length > 0);
  const images = [...named("Map on phone").querySelectorAll("img")];
  expect(images.length).toBeGreaterThan(5);
  for (const img of images) {
    const click = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => { img.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(false);
  }
  const css = readFileSync("src/components/TimelinePane.css", "utf8");
  expect(css).toMatch(/\.timeline-ink \{[^}]*pointer-events: none/);
  expect(css).not.toMatch(/\.timeline-canvas\[data-grabbing\] \{/);
});

it("pairs a crossed picture whose caption drops its option's letter", async () => {
  const text = "# Decision timeline\n\n## 2026-11-17 10:00 | Forum | current\n- Picked: B - blue cards\n- Over: A - red cards\n- Over pictures: C:\\Users\\me\\.orbit\\attachments\\red.png (red cards)\n";
  picks(() => new Response(JSON.stringify({ name: "decisions.md", text, entries: parseTimeline(text).entries }), { status: 200 }));
  await openTimeline("b-pair-bare");
  await until(() => picked().length > 0);
  expect([...picked()[0]!.querySelectorAll("[data-timeline-out]")].map((out) => [out.textContent, out.querySelector("img")?.getAttribute("src")?.split("/").pop()])).toEqual([["A - red cards", "red.png"]]);
});

it("shows a pick Auto Notes saves while the pane is open", async () => {
  picks(() => new Response(JSON.stringify({ error: "no such topic file" }), { status: 404 }));
  await openTimeline("b-live");
  await until(() => host.querySelector(".timeline-pane .show-media-empty") !== null);
  expect(picked()).toHaveLength(0);
  pickList();
  const saved = { id: "save-1", tool: { name: "memory.save", ok: true } };
  await act(async () => noteMemoryFrame({ kind: "message", threadId: "t1", message: saved }, { hydrated: true, bots: [{ id: "b-live", threadId: "t1" }] }));
  await until(() => picked().length === 5);
  expect(picked()).toHaveLength(5);
});

it.each([
  ["a room save for this bot", "room", false, "b-refresh"],
  ["a save on an earlier task", "earlier", false, undefined],
  ["a save replayed after reconnect", "t1", true, undefined],
] as const)("refreshes the open Timeline after %s", async (_label, threadId, replayed, memoryBotId) => {
  const botId = "b-refresh";
  const bots = [{ id: botId, threadId: "t1", tasks: [{ threadId: "earlier" }] }];
  picks(() => new Response(null, { status: 404 }));
  await openTimeline(botId);
  await until(() => host.querySelector(".timeline-pane .show-media-empty") !== null);
  pickList();
  const save = (id: string, owner?: string) => ({ id, tool: { name: "memory.save", ok: true, memoryBotId: owner } });
  await act(async () => noteMemoryFrame({ kind: "message", threadId, replayed, message: save("other-save", "other-bot") }, { hydrated: true, bots }));
  expect(picked()).toHaveLength(0);
  await act(async () => noteMemoryFrame({ kind: "message", threadId, replayed, message: save("bot-save", memoryBotId) }, { hydrated: true, bots }));
  await until(() => picked().length === 5);
  expect(picked()).toHaveLength(5);
});

it("refreshes the open Timeline when its bot receives a synced pick", async () => {
  const botId = "b-peer-sync";
  const bots = [{ id: botId, threadId: "t1" }];
  const sync = (id: string) => act(async () => noteMemoryFrame({ kind: "memory.changed", botId: id }, { hydrated: true, bots }));
  picks(() => new Response(null, { status: 404 }));
  await openTimeline(botId);
  await until(() => host.querySelector(".timeline-pane .show-media-empty") !== null);
  pickList();
  await sync("other-bot");
  expect(picked()).toHaveLength(0);
  await sync(botId);
  await until(() => picked().length === 5);
  expect(picked()).toHaveLength(5);
});

it.each([503, 404])("keeps the loaded Timeline rows when a save refresh fails with %i", async (status) => {
  const botId = `b-failed-refresh-${status}`;
  pickList();
  await openTimeline(botId);
  await until(() => picked().length === 5);
  const refresh = vi.fn(() => new Response(null, { status }));
  picks(refresh);
  const message = { id: "fact-save", tool: { name: "memory.save", ok: true } };
  await act(async () => noteMemoryFrame({ kind: "message", threadId: "t1", message }, { hydrated: true, bots: [{ id: botId, threadId: "t1" }] }));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(picked()).toHaveLength(5);
  expect(host.querySelector(".timeline-pane .show-media-empty")).toBeNull();
});

it("says so in one line when the bot has no picks yet", async () => {
  picks(() => new Response(JSON.stringify({ name: "decisions.md", text: "", entries: [] }), { status: 200 }));
  await openTimeline();
  await until(() => host.querySelector(".timeline-pane .show-media-empty") !== null);
  expect(host.querySelector(".timeline-pane")!.textContent).toBe("No picks yet");
  expect(host.querySelector(".timeline-search")).toBeNull();
});
