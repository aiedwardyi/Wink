// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MapPane } from "./MapPane";
import { applyLocale } from "@/lib/i18n";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
interface TestStream {
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  close(): void;
}
let stream: TestStream;
const close = vi.fn();
const workers = [
  { id: "a", nick: "ALPHA", task: "Fix layout", reason: "Keep the live edit in view", git: true, editedAt: 1, path: "src/a.ts", files: [{ path: "src/a.ts", added: 1, removed: 1 }, { path: "src/manual.ts", added: 2, removed: 0 }] },
  { id: "b", nick: "BETA", task: "Fix calls", git: true, editedAt: 2, path: "b.ts", files: [{ path: "b.ts", added: 1, removed: 0 }] },
];
const repo = { name: "wink", paths: ["README.md", "b.ts", "src/a.ts", "src/manual.ts", "src/z.ts", "server/x.ts"] };
const reads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/file?"));
const emit = (items = workers) => act(async () => { stream.onmessage?.({ data: JSON.stringify({ workers: items }) }); });
const click = (selector: string) => act(async () => { host.querySelector<HTMLButtonElement>(selector)!.click(); });

beforeEach(() => {
  close.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("EventSource", vi.fn(function () { stream = { close }; return stream; }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("/repo?") ? Response.json(repo) : Response.json({ lines: [{ kind: "add", text: "const edited = true;", line: 1 }] })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); applyLocale("en"); });

it("follows edits across workers, pins a worker, and keeps a manual file with Follow off", async () => {
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit();
  expect(host.querySelector("[data-map-worker]")?.getAttribute("data-map-worker")).toBe("b");
  expect(host.querySelector(".map-head")?.textContent).toBe("BETA");
  await click(".map-worker");
  await click('[role="menuitemradio"]:nth-child(2)');
  expect(host.querySelector("[data-map-worker]")?.getAttribute("data-map-worker")).toBe("a");
  expect(host.querySelector(".map-step h3")?.textContent).toBe("Keep the live edit in view");
  expect(host.querySelector(".map-step p")?.textContent).toBe("src/a.ts");
  await emit([workers[0], { ...workers[1], editedAt: 3 }]);
  expect(host.querySelector("[data-map-worker]")?.getAttribute("data-map-worker")).toBe("a");
  await click('[data-map-file="src/manual.ts"]');
  await emit([{ ...workers[0], editedAt: 4 }, workers[1]]);
  expect(host.querySelector("[data-map-path]")?.getAttribute("data-map-path")).toBe("src/manual.ts");
  expect(host.querySelector(".map-follow")?.getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelector(".map-code")?.textContent).toContain("const edited = true;");
  await act(async () => root.unmount());
  expect(close).toHaveBeenCalledOnce();
  root = createRoot(host);
});

it("uses plain empty and non-git lines in both languages", async () => {
  await act(async () => { applyLocale("ko"); root.render(createElement(MapPane, {})); });
  expect(host.textContent).toContain("실행 중인 작업자가 없어요");
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[0], git: false, files: [] }]);
  expect(host.textContent).toContain("Git 폴더가 아니에요");
});

it("requests only the selected file and recovers from a failed diff", async () => {
  const read = vi.mocked(fetch);
  const reply = read.getMockImplementation()!;
  let offline = true;
  read.mockImplementation(async (url, init) => String(url).includes("/file?") && offline ? (offline = false, Promise.reject(new Error("offline"))) : reply(url, init));
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit();
  expect(reads()).toHaveLength(1);
  expect(String(reads()[0][0])).toContain("worker=b&path=b.ts");
  expect(host.textContent).toContain("Could not load changes");
  await emit();
  expect(host.textContent).toContain("Could not load changes");
  await click(".map-empty button");
  expect(host.textContent).toContain("const edited = true;");
});

it("pauses hidden views without losing the user's manual selection", async () => {
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit();
  await click(".map-follow");
  const count = vi.mocked(fetch).mock.calls.length;
  await act(async () => root.render(createElement(MapPane, { botId: "bot", active: false })));
  expect(close).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledTimes(count);
  await act(async () => root.render(createElement(MapPane, { botId: "bot", active: true })));
  await emit([{ ...workers[0], editedAt: 8 }, workers[1]]);
  expect(host.querySelector("[data-map-worker]")?.getAttribute("data-map-worker")).toBe("b");
  expect(host.querySelector(".map-follow")?.getAttribute("aria-pressed")).toBe("false");
});

it("waits for the renewed snapshot before requesting an unchanged selected file", async () => {
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit();
  const read = vi.mocked(fetch);
  expect(read.mock.calls.filter(([url]) => !String(url).includes("/flow?"))).toHaveLength(2);
  await act(async () => root.render(createElement(MapPane, { botId: "bot", active: false })));
  read.mockRejectedValueOnce(new Error("snapshot not ready"));
  await act(async () => root.render(createElement(MapPane, { botId: "bot", active: true })));
  expect(read.mock.calls.filter(([url]) => !String(url).includes("/flow?"))).toHaveLength(2);
  read.mockReset().mockImplementation(async url => String(url).includes("/repo?") ? Response.json(repo) : Response.json({ lines: [{ kind: "add", text: "renewed diff", line: 1 }] }));
  await emit();
  expect(reads()).toHaveLength(1);
  expect(host.textContent).toContain("renewed diff");
});

it("lights changed squares by folder and opens a lit square's diff", async () => {
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([workers[0]]);
  expect(host.querySelector(".map-where")?.textContent).toBe("2 of 6 files changedwink / ALPHA");
  expect([...host.querySelectorAll(".map-cells i")].map(cell => cell.getAttribute("title"))).toEqual(["src/a.ts", "src/manual.ts", "src/z.ts", "README.md", "b.ts", "server/x.ts"]);
  expect([...host.querySelectorAll(".map-cells i[data-on]")].map(cell => cell.getAttribute("title"))).toEqual(["src/a.ts", "src/manual.ts"]);
  expect(host.textContent).toContain("One square, one file. Lit ones changed.");
  await act(async () => { host.querySelector<HTMLElement>('[data-square="src/manual.ts"]')!.click(); });
  expect(host.querySelector("[data-map-path]")?.getAttribute("data-map-path")).toBe("src/manual.ts");
  expect(host.querySelector(".map-follow")?.getAttribute("aria-pressed")).toBe("false");
  expect(String(reads().at(-1)?.[0])).toContain("path=src%2Fmanual.ts");
});

it("moves the arrow to the row just edited and shows the path when the worker left no note", async () => {
  let resized: (() => void) | undefined;
  vi.stubGlobal("ResizeObserver", vi.fn(function (callback: () => void) { resized = callback; return { observe() {}, disconnect() {} }; }));
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[1], editedAt: Date.UTC(2026, 10, 13, 1, 16, 7) }]);
  const row = host.querySelector('[data-map-file="b.ts"]')!;
  Object.defineProperties(row, { offsetLeft: { value: 220 }, offsetTop: { value: 48 } });
  for (const height of [24, 28]) {
    Object.defineProperties(row.querySelector("i")!, { offsetLeft: { value: 7, configurable: true }, offsetTop: { value: height / 2 - 3.5, configurable: true }, offsetWidth: { value: 7, configurable: true }, offsetHeight: { value: 7, configurable: true } });
    await act(async () => resized?.());
    const [x, y] = host.querySelector<HTMLElement>(".map-pin")!.style.transform.match(/-?[\d.]+/g)!.map(Number);
    const tip = { x: x + 2.2, y: y + 0.9 };
    expect(tip.x).toBeGreaterThan(227);
    expect(tip.x).toBeLessThan(234);
    expect(tip.y).toBeGreaterThan(48 + height / 2 - 3.5);
    expect(tip.y).toBeLessThan(48 + height / 2 + 3.5);
  }
  expect(row.querySelector(".map-delta")?.textContent).toBe("+1");
  expect(host.querySelector(".map-step h3")?.textContent).toBe("b.ts");
  expect(host.querySelector(".map-step p")).toBeNull();
  expect(host.querySelector(".map-step time")?.getAttribute("datetime")).toBe("2026-11-13T01:16:07.000Z");
});

it("keeps the step title, breadcrumb and diff on one file through every hop", async () => {
  const waiting: (() => void)[] = [];
  vi.mocked(fetch).mockImplementation(url => {
    const path = new URL(String(url), "http://test").searchParams.get("path");
    if (!path) return Promise.resolve(Response.json(repo));
    return new Promise(resolve => waiting.push(() => resolve(Response.json({ lines: [{ kind: "add", text: `edit in ${path}`, line: 1 }] }))));
  });
  const settle = () => act(async () => { for (const done of waiting.splice(0)) done(); });
  const view = () => [".map-path b", ".map-step h3", ".map-step p", ".map-code"].map(selector => host.querySelector(selector)?.textContent);
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([workers[0]]);
  await settle();
  const first = ["a.ts", "Keep the live edit in view", "src/a.ts", "1+edit in src/a.ts"];
  expect(view()).toEqual(first);
  await emit([{ ...workers[0], editedAt: 2, path: "src/manual.ts", reason: "Add the manual" }]);
  expect(view()).toEqual(first);
  await settle();
  expect(view()).toEqual(["manual.ts", "Add the manual", "src/manual.ts", "1+edit in src/manual.ts"]);
  await click('[data-map-file="src/a.ts"]');
  await settle();
  await emit([{ ...workers[0], editedAt: 3, path: "src/manual.ts", reason: "Wire the manual" }]);
  await settle();
  expect(view()).toEqual(["a.ts", "src/a.ts", undefined, "1+edit in src/a.ts"]);
});

it("steps through the changed files with Up and Down only where the Map has focus", async () => {
  const scrolled = vi.fn();
  const key = (target: Element, init: KeyboardEventInit) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
  const path = () => host.querySelector("[data-map-path]")?.getAttribute("data-map-path");
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[0], files: [...workers[0].files, { path: "src/z.ts", added: 3, removed: 0 }] }]);
  for (const item of host.querySelectorAll<HTMLElement>("[data-map-file]")) item.scrollIntoView = () => scrolled(item.dataset.mapFile);
  const row = host.querySelector('[data-map-file="src/a.ts"]')!;
  await key(row, { key: "ArrowDown" });
  expect(path()).toBe("src/manual.ts");
  expect(host.querySelector(".map-follow")?.getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelector('[aria-current="true"]')?.getAttribute("data-map-file")).toBe("src/manual.ts");
  expect(scrolled).toHaveBeenLastCalledWith("src/manual.ts");
  expect(document.activeElement?.getAttribute("data-map-file")).toBe("src/manual.ts");
  await key(row, { key: "ArrowDown" });
  await key(row, { key: "ArrowDown" });
  expect(path()).toBe("src/z.ts");
  expect(host.querySelector(".map-path b")?.textContent).toBe("z.ts");
  await key(row, { key: "ArrowUp" });
  await key(row, { key: "ArrowUp" });
  const count = reads().length;
  await key(row, { key: "ArrowUp" });
  expect(path()).toBe("src/a.ts");
  expect(reads()).toHaveLength(count);
  expect(host.querySelector(".map-step p")?.textContent).toBe("src/a.ts");
  for (const [target, init] of [[row, { key: "ArrowDown", ctrlKey: true }], [row, { key: "j" }], [host.querySelector(".map-worker")!, { key: "ArrowDown" }], [document.body, { key: "ArrowDown" }]] as const) await key(target, init);
  const field = document.createElement("textarea");
  host.querySelector(".map-code")!.append(field);
  await key(field, { key: "ArrowDown" });
  expect(path()).toBe("src/a.ts");
});

it("drops a fold response from an earlier edit and keeps lines a capped file left out folded", async () => {
  const pending: ((lines: object[]) => void)[] = [];
  vi.mocked(fetch).mockImplementation(async url => {
    const query = new URL(String(url), "http://test").searchParams;
    if (!query.get("path")) return Response.json(repo);
    if (query.get("whole") === "1") return new Promise(done => pending.push(lines => done(Response.json({ lines, capped: true }))));
    return Response.json({ lines: [{ kind: "fold", text: "", count: 2, line: 1 }, { kind: "add", text: "edit", line: 3 }] });
  });
  const rows = () => [...host.querySelectorAll(".map-code-row code, .map-gap")].map(row => row.textContent);
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([workers[0]]);
  await click("button.map-gap");
  await emit([{ ...workers[0], editedAt: 5 }]);
  await act(async () => pending.shift()!([{ kind: "context", text: "stale", line: 1 }, { kind: "context", text: "stale", line: 2 }]));
  expect(rows()).toEqual(["2 lines unchanged", "edit"]);
  await click("button.map-gap");
  await act(async () => pending.shift()!([{ kind: "context", text: "one", line: 1 }]));
  expect(rows()).toEqual(["one", "Large diff folded", "edit"]);
});

it("opens a folded run in place and keeps the whole file on while the pane is open", async () => {
  vi.mocked(fetch).mockImplementation(async url => {
    const query = new URL(String(url), "http://test").searchParams;
    if (!query.get("path")) return Response.json(repo);
    const edit = { kind: "add", text: `edit in ${query.get("path")}`, line: 3 };
    return Response.json({ lines: query.get("whole") === "1" ? [{ kind: "context", text: "one", line: 1 }, { kind: "context", text: "two", line: 2 }, edit] : [{ kind: "fold", text: "", count: 2, line: 1 }, edit] });
  });
  const rows = () => [...host.querySelectorAll(".map-code-row code, .map-gap")].map(row => row.textContent);
  await act(async () => { applyLocale("ko"); root.render(createElement(MapPane, { botId: "bot" })); });
  await emit([workers[0]]);
  expect(rows()).toEqual(["변경 없는 2줄", "edit in src/a.ts"]);
  expect(host.querySelector(".map-whole")?.textContent).toBe("전체 파일");
  await click("button.map-gap");
  expect(rows()).toEqual(["one", "two", "edit in src/a.ts"]);
  expect(String(reads().at(-1)?.[0])).toContain("whole=1");
  await click('[data-map-file="src/manual.ts"]');
  expect(rows()).toEqual(["변경 없는 2줄", "edit in src/manual.ts"]);
  await click(".map-whole");
  expect(host.querySelector(".map-whole")?.getAttribute("aria-pressed")).toBe("true");
  expect(rows()).toEqual(["one", "two", "edit in src/manual.ts"]);
  await click('[data-map-file="src/a.ts"]');
  expect(rows()).toEqual(["one", "two", "edit in src/a.ts"]);
  expect(host.querySelector(".map-code-row[data-kind='add']")).not.toBeNull();
  await click(".map-whole");
  expect(rows()).toEqual(["변경 없는 2줄", "edit in src/a.ts"]);
});
