// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MapPane } from "./MapPane";
import { tokenize } from "@/lib/map-highlight.worker";
import { applyLocale } from "@/lib/i18n";
import { mapWorkerColor } from "@/lib/map-worker-colors";

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
const emit = (items: object[] = workers) => act(async () => { stream.onmessage?.({ data: JSON.stringify({ workers: items }) }); });
const click = (selector: string) => act(async () => { host.querySelector<HTMLButtonElement>(selector)!.click(); });
type Spot = { x: number; y: number };
const offLine = (points: Spot[], a: Spot, b: Spot) => Math.max(...points.map(p => {
  const k = Math.min(1, Math.max(0, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2)));
  return Math.hypot(p.x - a.x - k * (b.x - a.x), p.y - a.y - k * (b.y - a.y));
}));

beforeEach(() => {
  close.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("EventSource", vi.fn(function () { stream = { close }; return stream; }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("Worker", Tokenizer);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("/repo?") ? Response.json(repo) : Response.json({ lines: [{ kind: "add", text: "const edited = true;", line: 1 }] })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); applyLocale("en"); });

it("labels root and folder counts in both languages", async () => {
  const paths = [...Array.from({ length: 1100 }, (_, i) => `src/${i}.ts`), "src/a.ts", "src/manual.ts", "server/x.ts"];
  vi.mocked(fetch).mockImplementation(async url => String(url).includes("/repo?") ? Response.json({ name: "wink", paths }) : Response.json({ lines: [] }));
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([workers[0]]);
  const counts = () => [...host.querySelectorAll<HTMLElement>(".map-tree-box:not(.map-tree-more) > span")];
  const check = (titles: string[]) => {
    expect(counts().map(count => count.querySelector('[aria-hidden="true"]')?.textContent)).toEqual(["1,103", "1,102", "1"]);
    expect(counts().map(count => count.getAttribute("title"))).toEqual(titles);
    expect(counts().map(count => count.querySelector(".sr-only")?.textContent)).toEqual(titles);
    expect(counts().every(count => !count.hasAttribute("tabindex"))).toBe(true);
  };
  check(["1,103 files", "1,102 files", "1 file"]);
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => { applyLocale("ko"); root.render(createElement(MapPane, { botId: "bot" })); });
  await emit([workers[0]]);
  check(["파일 1,103개", "파일 1,102개", "파일 1개"]);
});

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
  expect(host.querySelector(".map-where")?.textContent).toBe("파일 6개 · Git 폴더가 아니에요wink / ALPHA");
  expect([...host.querySelectorAll(".map-tree-file")].map(row => row.getAttribute("title"))).toEqual(["src/a.ts", "src/manual.ts", "src/z.ts", "server/x.ts", "README.md", "b.ts"]);
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

it("asks for Git rows only once the tree and the code have landed", async () => {
  const held: Record<string, (body: object) => void> = {};
  vi.mocked(fetch).mockImplementation(url => {
    const kind = /\/(repo|file|flow)\?/.exec(String(url))![1];
    return kind === "flow" ? Promise.resolve(Response.json({ commits: [] })) : new Promise(done => { held[kind] = body => done(Response.json(body)); });
  });
  const asked = () => vi.mocked(fetch).mock.calls.map(([url]) => /\/(repo|file|flow)\?/.exec(String(url))![1]);
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit();
  expect(asked().toSorted()).toEqual(["file", "repo"]);
  await act(async () => held.repo(repo));
  expect(asked()).not.toContain("flow");
  await act(async () => held.file({ lines: [{ kind: "add", text: "const edited = true;", line: 1 }] }));
  expect(asked().filter(kind => kind === "flow")).toHaveLength(2);
  expect(host.querySelector(".map-tree-file")).not.toBeNull();
  expect(host.textContent).toContain("const edited = true;");
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

it("draws the repo as a tree in place of the squares and the changed-files list, every file of a small repo shown", async () => {
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([workers[0]]);
  expect(host.querySelector(".map-where")?.textContent).toBe("Changed 2 of 6 fileswink / ALPHA");
  expect(host.querySelector(".map-squares, .map-files, .map-file-label")).toBeNull();
  expect([...host.querySelectorAll(".map-tree-box b")].map(box => box.textContent)).toEqual(["wink", "src/", "server/"]);
  expect([...host.querySelectorAll(".map-tree-file")].map(row => row.getAttribute("title"))).toEqual(["src/a.ts", "src/manual.ts", "src/z.ts", "server/x.ts", "README.md", "b.ts"]);
  expect([...host.querySelectorAll("button.map-tree-file")].map(row => row.getAttribute("data-map-file"))).toEqual(["src/a.ts", "src/manual.ts"]);
});

it.each([[true, 44], [false, 17]])("gives each file row a finger's height on a phone and keeps the desktop pitch: phone %s", async (phone, height) => {
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: phone && query.includes("max-width"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([workers[0]]);
  const rows = ["src/a.ts", "src/manual.ts"].map(path => host.querySelector<HTMLElement>(`button.map-tree-file[data-map-file="${path}"]`)!);
  expect(rows.map(row => parseFloat(row.style.height) || 17)).toEqual([height, height]);
  expect(parseFloat(rows[1].style.top) - parseFloat(rows[0].style.top)).toBe(height);
});

it("opens a changed file box in the viewer below", async () => {
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([workers[0]]);
  await click('.map-tree-file[data-map-file="src/manual.ts"]');
  expect(host.querySelector("[data-map-path]")?.getAttribute("data-map-path")).toBe("src/manual.ts");
  expect(host.querySelector(".map-follow")?.getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelector('.map-tree-file[aria-current="true"]')?.getAttribute("data-map-file")).toBe("src/manual.ts");
  expect(String(reads().at(-1)?.[0])).toContain("path=src%2Fmanual.ts");
  expect(host.querySelector(".map-code")?.textContent).toContain("const edited = true;");
});

it("puts every worker on one tree in its own color and marks clashes by how near their lines are", async () => {
  const team = [
    { ...workers[0], files: [{ path: "src/a.ts", added: 1, removed: 1, ranges: [[10, 12]] }, { path: "b.ts", added: 1, removed: 0, ranges: [[1, 1]] }, { path: "src/manual.ts", added: 2, removed: 0, ranges: [[1, 2]] }] },
    { ...workers[1], files: [{ path: "src/a.ts", added: 1, removed: 0, ranges: [[15, 15]] }, { path: "b.ts", added: 1, removed: 0, ranges: [[5, 5]] }] },
  ];
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit(team);
  expect(host.querySelector(".map-where")?.textContent).toBe("2 workers · 3 of 6 files changed · 2 clasheswink / 2 workers");
  expect([...host.querySelectorAll(".map-tree-legend span")].map(item => item.textContent)).toEqual(["ALPHA3", "BETA2"]);
  expect([...host.querySelectorAll(".map-tree-clash")].map(row => [row.textContent, row.querySelector(".map-tree-x[data-same]") !== null])).toEqual([
    ["a.tsALPHA + BETA · same lines", true],
    ["b.tsALPHA + BETA · different lines", false],
  ]);
  expect(host.querySelector('.map-tree-file[data-map-file="src/a.ts"] .map-tree-x[data-same]')).not.toBeNull();
  expect(host.querySelector('.map-tree-file[data-map-file="b.ts"] .map-tree-x:not([data-same])')).not.toBeNull();
  expect(host.querySelector<HTMLElement>('.map-tree-sq[data-map-file="src/manual.ts"]')?.style.getPropertyValue("--c")).toBe(mapWorkerColor(0));
  expect(host.querySelector<HTMLElement>('.map-tree-sq[data-map-file="src/a.ts"]')?.style.getPropertyValue("--c")).toContain(mapWorkerColor(1));
  await click('.map-tree-sq[data-map-file="src/manual.ts"]');
  expect(host.querySelector("[data-map-worker]")?.getAttribute("data-map-worker")).toBe("a");
  expect(host.querySelector("[data-map-path]")?.getAttribute("data-map-path")).toBe("src/manual.ts");
  await emit([{ ...team[0], files: team[0].files.map(file => file.path === "b.ts" ? { ...file, ranges: [[2, 2]] } : file) }, team[1]]);
  expect(host.querySelector('.map-tree-file[data-map-file="b.ts"] .map-tree-x[data-same]')).not.toBeNull();
});

it("marks a file filled when any two of its workers overlap", async () => {
  const team = [
    { ...workers[0], files: [{ path: "src/a.ts", added: 1, removed: 0, ranges: [[10, 12]] }] },
    { ...workers[1], files: [{ path: "src/a.ts", added: 1, removed: 0, ranges: [[100, 102]] }] },
    { ...workers[1], id: "c", nick: "GAMMA", editedAt: 0, files: [{ path: "src/a.ts", added: 1, removed: 0, ranges: [[11, 13]] }] },
  ];
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit(team);
  expect(host.querySelector('.map-tree-file[data-map-file="src/a.ts"] .map-tree-x[data-same]')).not.toBeNull();
});

it("opens a folded branch's changed file from its box on a narrow pane", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
  const paths = ["src", "server", "docs"].flatMap(dir => Array.from({ length: 20 }, (_, i) => `${dir}/f${i}.ts`));
  vi.mocked(fetch).mockImplementation(async url => String(url).includes("/repo?") ? Response.json({ name: "wink", paths }) : Response.json({ lines: [{ kind: "add", text: "x", line: 1 }] }));
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[0], path: "src/f1.ts", files: [{ path: "src/f1.ts", added: 1, removed: 0 }, { path: "server/f2.ts", added: 1, removed: 0 }] }]);
  expect(host.querySelector('[data-map-file="server/f2.ts"]')).toBeNull();
  const box = [...host.querySelectorAll<HTMLButtonElement>("button.map-tree-box")].find(box => box.textContent?.startsWith("server/"));
  await act(async () => box!.click());
  expect(host.querySelector("[data-map-path]")?.getAttribute("data-map-path")).toBe("server/f2.ts");
  expect(host.querySelector('.map-tree-file[aria-current="true"]')?.getAttribute("data-map-file")).toBe("server/f2.ts");
});

it("rests the pointer's tip on the bottom-right corner of the edited file's square without covering it or the name, and shows the path when the worker left no note", async () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "MapTree.css"), "utf8");
  expect(css).toMatch(/\.map-tree-file \{ position: absolute; left: 14px; [^}]*align-items: center; gap: 6px; height: 17px;/);
  expect(css).toMatch(/\.map-tree-file i \{ flex: none; width: 7px; height: 7px;/);
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[1], editedAt: Date.UTC(2026, 10, 13, 1, 16, 7) }]);
  const numbers = (element: HTMLElement) => element.style.transform.match(/-?[\d.]+/g)!.map(Number);
  for (const path of ["b.ts", "src/a.ts"]) {
    if (path !== "b.ts") await emit([{ ...workers[1], editedAt: Date.UTC(2026, 10, 13, 1, 17), path, files: [...workers[1].files, { path, added: 2, removed: 0 }] }]);
    await vi.waitFor(() => {
      const row = host.querySelector<HTMLElement>(`.map-tree-file[title="${path}"]`)!;
      const [x, y] = numbers(row.closest<HTMLElement>(".map-tree-n")!);
      const mid = y + parseFloat(row.parentElement!.style.top) + parseFloat(row.style.top) + 17 / 2;
      const [px, py] = numbers(host.querySelector<HTMLElement>(".map-tree-pin")!);
      const tip = { x: px + 1.4, y: py + 0.7 };
      const square = { left: x + 14, right: x + 21, top: mid - 3.5, bottom: mid + 3.5 };
      const gap = Math.hypot(Math.max(square.left - tip.x, 0, tip.x - square.right), Math.max(square.top - tip.y, 0, tip.y - square.bottom));
      expect(row.firstElementChild?.tagName).toBe("I");
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(2);
      expect(tip.x).toBeGreaterThanOrEqual(square.right);
      expect(tip.y).toBeGreaterThanOrEqual(square.bottom);
      expect(tip.x).toBeLessThan(x + 14 + 13);
    });
  }
  await emit([{ ...workers[1], editedAt: Date.UTC(2026, 10, 13, 1, 16, 7) }]);
  expect(host.querySelector(".map-step h3")?.textContent).toBe("b.ts");
  expect(host.querySelector(".map-step p")).toBeNull();
  expect(host.querySelector(".map-step time")?.getAttribute("datetime")).toBe("2026-11-13T01:16:07.000Z");
});

it("moves the one arrow to the file picked with Up, Down or a click, keeps it there off Follow, and draws no box", async () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "MapTree.css"), "utf8");
  expect(css).not.toMatch(/\.map-tree-(file|sq)\[aria-current/);
  expect(css).toMatch(/\.map-tree-file:focus-visible, \.map-tree-sq:focus-visible \{ outline: none; \}/);
  const numbers = (element: HTMLElement) => element.style.transform.match(/-?[\d.]+/g)!.map(Number);
  const pointsAt = (path: string) => vi.waitFor(() => {
    const row = host.querySelector<HTMLElement>(`.map-tree-file[title="${path}"]`)!;
    const [, y] = numbers(row.closest<HTMLElement>(".map-tree-n")!);
    const top = y + parseFloat(row.parentElement!.style.top) + parseFloat(row.style.top) + 17 / 2;
    expect(Math.abs(numbers(host.querySelector<HTMLElement>(".map-tree-pin")!)[1] + 0.7 - top - 4.5)).toBeLessThan(1);
  }, { timeout: 3000 });
  const key = (path: string, k: string) => act(async () => { host.querySelector(`[data-map-file="${path}"]`)!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
  const edits = [{ path: "README.md", added: 1, removed: 0 }, ...workers[0].files, { path: "src/z.ts", added: 3, removed: 0 }];
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[0], files: edits }]);
  await pointsAt("src/a.ts");
  await key("src/a.ts", "ArrowDown");
  await pointsAt("src/manual.ts");
  await key("src/manual.ts", "ArrowDown");
  await pointsAt("src/z.ts");
  expect(host.querySelector('[aria-current="true"]')?.getAttribute("data-map-file")).toBe("src/z.ts");
  await click('[data-map-file="README.md"]');
  await pointsAt("README.md");
  await emit([{ ...workers[0], files: edits, editedAt: 5, path: "src/manual.ts" }]);
  await act(() => new Promise(done => setTimeout(done, 900)));
  await pointsAt("README.md");
  await click(".map-follow");
  await pointsAt("src/manual.ts");
  await emit([{ ...workers[0], editedAt: 6 }, workers[1]]);
  expect(host.querySelectorAll(".map-tree-pin")).toHaveLength(1);
  await pointsAt("src/a.ts");
  await click('[data-map-file="b.ts"]');
  await pointsAt("b.ts");
});

it("lights the picked file's square at once and sends the arrow a beat behind, straight there on a held key", async () => {
  let clock = 1000;
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (done: FrameRequestCallback) => { frames.set(++id, done); return id; });
  vi.stubGlobal("cancelAnimationFrame", (at: number) => frames.delete(at));
  const step = (ms: number) => { clock += ms; const due = [...frames.values()]; frames.clear(); for (const done of due) done(clock); };
  const pin = () => host.querySelector<HTMLElement>(".map-tree-pin")!.style.transform;
  const lit = () => [...host.querySelectorAll(".map-tree-file[data-lit]")].map(row => row.getAttribute("title"));
  const key = (path: string, repeat: boolean) => act(async () => { host.querySelector(`[data-map-file="${path}"]`)!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", repeat, bubbles: true, cancelable: true })); });
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[0], files: [...workers[0].files, { path: "src/z.ts", added: 3, removed: 0 }] }]);
  for (let i = 0; i < 10; i++) step(200);
  expect(lit()).toEqual(["src/a.ts"]);
  const rest = pin();
  await key("src/a.ts", false);
  expect(lit()).toEqual(["src/manual.ts"]);
  step(100);
  expect(pin()).toBe(rest);
  step(300);
  expect(pin()).not.toBe(rest);
  for (let i = 0; i < 10; i++) step(200);
  const next = pin();
  await key("src/manual.ts", true);
  expect(lit()).toEqual(["src/z.ts"]);
  const jumped = pin();
  expect(jumped).not.toBe(next);
  step(200);
  expect(pin()).toBe(jumped);
});

it("walks a worker's edit along the tree lines but sends a clicked file's arrow straight there", async () => {
  let clock = 1000;
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (done: FrameRequestCallback) => { frames.set(++id, done); return id; });
  vi.stubGlobal("cancelAnimationFrame", (at: number) => frames.delete(at));
  const step = (ms: number) => { clock += ms; const due = [...frames.values()]; frames.clear(); for (const done of due) done(clock); };
  const tip = () => { const [x, y] = host.querySelector<HTMLElement>(".map-tree-pin")!.style.transform.match(/-?[\d.]+/g)!.map(Number); return { x: x + 1.4, y: y + 0.7 }; };
  const travel = () => { const trail = [tip()]; for (let ms = 0; ms < 1000; ms += 16) { step(16); trail.push(tip()); } return trail; };
  const edit = { path: "src/a.ts", added: 2, removed: 0 };
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([workers[1]]);
  for (let i = 0; i < 10; i++) step(200);
  const home = tip();
  await emit([{ ...workers[1], editedAt: 3, path: edit.path, files: [...workers[1].files, edit] }]);
  const walked = travel();
  expect(offLine(walked, home, walked.at(-1)!)).toBeGreaterThan(3);
  await click('[data-map-file="b.ts"]');
  const picked = travel();
  expect(new Set(picked.map(at => `${at.x} ${at.y}`)).size).toBeGreaterThan(5);
  expect(picked.at(-1)).toEqual(home);
  expect(offLine(picked, walked.at(-1)!, home)).toBeLessThan(0.5);
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

it("opens only a file from the folders a folded folders box holds, never one under a visible box", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
  const dirs: [string, number][] = [["src", 20], ["big", 20], ["c1", 6], ["c2", 6], ["c3", 6], ["c4", 6], ["zeta-folder-long", 2]];
  const paths = dirs.flatMap(([dir, n]) => Array.from({ length: n }, (_, i) => `${dir}/f${i}.ts`));
  vi.mocked(fetch).mockImplementation(async url => String(url).includes("/repo?") ? Response.json({ name: "wink", paths }) : Response.json({ lines: [{ kind: "add", text: "x", line: 1 }] }));
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[0], path: "src/f1.ts", files: ["src/f1.ts", "big/f2.ts", "zeta-folder-long/f1.ts"].map(path => ({ path, added: 1, removed: 0 })) }]);
  expect([...host.querySelectorAll("button.map-tree-box > b")].map(box => box.textContent)).toContain("big/");
  await act(async () => host.querySelector<HTMLButtonElement>("button.map-tree-more")!.click());
  expect(host.querySelector("[data-map-path]")?.getAttribute("data-map-path")).toBe("zeta-folder-long/f1.ts");
});

it("moves focus with Up and Down onto a file that sat in a folded box", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
  const paths = ["src", "server", "docs"].flatMap(dir => Array.from({ length: 20 }, (_, i) => `${dir}/f${i}.ts`));
  vi.mocked(fetch).mockImplementation(async url => String(url).includes("/repo?") ? Response.json({ name: "wink", paths }) : Response.json({ lines: [{ kind: "add", text: "x", line: 1 }] }));
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[0], path: "src/f1.ts", files: [{ path: "src/f1.ts", added: 1, removed: 0 }, { path: "server/f2.ts", added: 1, removed: 0 }] }]);
  expect(host.querySelector('[data-map-file="server/f2.ts"]')).toBeNull();
  const row = host.querySelector<HTMLElement>('[data-map-file="src/f1.ts"]')!;
  row.focus();
  await act(async () => { row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })); });
  expect(host.querySelector('[aria-current="true"]')?.getAttribute("data-map-file")).toBe("server/f2.ts");
  expect(document.activeElement?.getAttribute("data-map-file")).toBe("server/f2.ts");
});

it("sends a picked file's arrow in one straight line into a branch that opens as another folds, and jumps on a held key", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
  const paths = ["src", "server", "docs"].flatMap(dir => Array.from({ length: 20 }, (_, i) => `${dir}/f${i}.ts`));
  vi.mocked(fetch).mockImplementation(async url => String(url).includes("/repo?") ? Response.json({ name: "wink", paths }) : Response.json({ lines: [{ kind: "add", text: "x", line: 1 }] }));
  let clock = 1000;
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (done: FrameRequestCallback) => { frames.set(++id, done); return id; });
  vi.stubGlobal("cancelAnimationFrame", (at: number) => frames.delete(at));
  const step = (ms: number) => { clock += ms; const due = [...frames.values()]; frames.clear(); for (const done of due) done(clock); };
  const numbers = (element: HTMLElement) => element.style.transform.match(/-?[\d.]+/g)!.map(Number);
  const tip = () => { const [x, y] = numbers(host.querySelector<HTMLElement>(".map-tree-pin")!); return { x: x + 1.4, y: y + 0.7 }; };
  const off = (path: string) => {
    const row = host.querySelector<HTMLElement>(`.map-tree-file[title="${path}"]`)!;
    const [x, y] = numbers(row.closest<HTMLElement>(".map-tree-n")!);
    const at = tip();
    return Math.hypot(at.x - x - 14 - 8, at.y - y - parseFloat(row.parentElement!.style.top) - parseFloat(row.style.top) - 17 / 2 - 4.5);
  };
  const key = (path: string, repeat: boolean) => act(async () => { host.querySelector(`[data-map-file="${path}"]`)!.dispatchEvent(new KeyboardEvent("keydown", { key: repeat ? "ArrowDown" : "ArrowUp", repeat, bubbles: true, cancelable: true })); });
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[0], path: "src/f1.ts", files: [{ path: "src/f1.ts", added: 1, removed: 0 }, { path: "server/f2.ts", added: 1, removed: 0 }] }]);
  for (let i = 0; i < 10; i++) step(200);
  expect(off("src/f1.ts")).toBeLessThan(1);
  const before = tip();
  await key("src/f1.ts", false);
  expect(host.querySelector('.map-tree-file[aria-current="true"]')?.getAttribute("data-map-file")).toBe("server/f2.ts");
  expect(tip()).toEqual(before);
  expect(off("server/f2.ts")).toBeGreaterThan(20);
  step(115);
  expect(tip()).toEqual(before);
  step(35);
  const first = tip();
  expect(Math.hypot(first.x - before.x, first.y - before.y)).toBeGreaterThan(1);
  const trail = [first];
  for (let ms = 16; ms < 440; ms += 16) { step(16); trail.push(tip()); }
  step(16);
  expect(off("server/f2.ts")).toBeLessThan(1);
  expect(new Set(trail.map(at => `${at.x} ${at.y}`)).size).toBeGreaterThan(5);
  expect(offLine(trail, before, tip())).toBeLessThan(0.5);
  for (let i = 0; i < 5; i++) step(200);
  await key("server/f2.ts", true);
  expect(host.querySelector('.map-tree-file[aria-current="true"]')?.getAttribute("data-map-file")).toBe("src/f1.ts");
  expect(off("src/f1.ts")).toBeLessThan(1);
});

it("keeps the changed files on the tree with a Retry when the repo's files fail to load", async () => {
  let down = true;
  vi.mocked(fetch).mockImplementation(async url => String(url).includes("/repo?") ? down ? new Response("", { status: 503 }) : Response.json(repo) : Response.json({ lines: [{ kind: "add", text: "x", line: 1 }] }));
  const path = () => host.querySelector("[data-map-path]")?.getAttribute("data-map-path");
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([workers[0]]);
  expect(host.querySelector(".map-top .map-empty")?.textContent).toBe("Could not load all files Retry");
  await click('[data-map-file="src/manual.ts"]');
  expect(path()).toBe("src/manual.ts");
  await act(async () => { host.querySelector('[data-map-file="src/manual.ts"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })); });
  expect(path()).toBe("src/a.ts");
  down = false;
  await click(".map-top .map-empty button");
  expect(host.querySelector(".map-top .map-empty")).toBeNull();
  expect(host.querySelector('.map-tree-file[data-tree-row="README.md"]')).not.toBeNull();
});

it("steps through the changed files in tree order with Up and Down only where the Map has focus", async () => {
  const scrolled = vi.fn();
  const key = (target: Element, init: KeyboardEventInit) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
  const path = () => host.querySelector("[data-map-path]")?.getAttribute("data-map-path");
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[0], files: [{ path: "README.md", added: 1, removed: 0 }, ...workers[0].files, { path: "src/z.ts", added: 3, removed: 0 }] }]);
  for (const item of host.querySelectorAll<HTMLElement>("[data-map-file]")) item.scrollIntoView = () => scrolled(item.dataset.mapFile);
  const row = host.querySelector('[data-map-file="src/a.ts"]')!;
  await key(row, { key: "ArrowDown" });
  expect(path()).toBe("src/manual.ts");
  expect(host.querySelector(".map-follow")?.getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelector('[aria-current="true"]')?.getAttribute("data-map-file")).toBe("src/manual.ts");
  expect(scrolled).toHaveBeenLastCalledWith("src/manual.ts");
  expect(document.activeElement?.getAttribute("data-map-file")).toBe("src/manual.ts");
  await key(row, { key: "ArrowDown" });
  expect(path()).toBe("src/z.ts");
  expect(host.querySelector(".map-path b")?.textContent).toBe("z.ts");
  await key(row, { key: "ArrowDown" });
  await key(row, { key: "ArrowDown" });
  expect(path()).toBe("README.md");
  for (let step = 0; step < 3; step++) await key(row, { key: "ArrowUp" });
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
  pending.shift()!([]);
  await click('.map-crumbs [role="radio"][aria-checked="false"]');
  await click("button.map-gap");
  await emit([{ ...workers[0], editedAt: 5 }]);
  await act(async () => pending.shift()!([{ kind: "context", text: "stale", line: 1 }, { kind: "context", text: "stale", line: 2 }]));
  expect(rows()).toEqual(["2 lines unchanged", "edit"]);
  await click("button.map-gap");
  await act(async () => pending.shift()!([{ kind: "context", text: "one", line: 1 }]));
  expect(rows()).toEqual(["one", "Large diff folded", "edit"]);
});

it("opens the whole file by default, flips to changes only, and opens a folded run in place", async () => {
  vi.mocked(fetch).mockImplementation(async url => {
    const query = new URL(String(url), "http://test").searchParams;
    if (!query.get("path")) return Response.json(repo);
    const edit = { kind: "add", text: `edit in ${query.get("path")}`, line: 3 };
    return Response.json({ lines: query.get("whole") === "1" ? [{ kind: "context", text: "one", line: 1 }, { kind: "context", text: "two", line: 2 }, edit] : [{ kind: "fold", text: "", count: 2, line: 1 }, edit] });
  });
  const rows = () => [...host.querySelectorAll(".map-code-row code, .map-gap")].map(row => row.textContent);
  await act(async () => { applyLocale("ko"); root.render(createElement(MapPane, { botId: "bot" })); });
  await emit([workers[0]]);
  expect(rows()).toEqual(["one", "two", "edit in src/a.ts"]);
  expect(String(reads().at(-1)?.[0])).toContain("whole=1");
  expect(host.querySelector('.map-crumbs [role="radio"][aria-checked="true"]')?.textContent).toBe("전체 파일");
  await click('.map-crumbs [role="radio"][aria-checked="false"]');
  expect([...host.querySelectorAll('.map-crumbs [role="radio"]')].map(side => [side.textContent, side.getAttribute("aria-checked")])).toEqual([["변경만", "true"], ["전체 파일", "false"]]);
  expect(rows()).toEqual(["변경 없는 2줄", "edit in src/a.ts"]);
  await click("button.map-gap");
  expect(rows()).toEqual(["one", "two", "edit in src/a.ts"]);
  await click('[data-map-file="src/manual.ts"]');
  expect(rows()).toEqual(["변경 없는 2줄", "edit in src/manual.ts"]);
  await click('.map-crumbs [role="radio"][aria-checked="false"]');
  expect(rows()).toEqual(["one", "two", "edit in src/manual.ts"]);
  await click('[data-map-file="src/a.ts"]');
  expect(rows()).toEqual(["one", "two", "edit in src/a.ts"]);
  expect(host.querySelector(".map-code-row[data-kind='add']")).not.toBeNull();
});

it("scrolls the whole file to its first change and falls back to changes only past the cap", async () => {
  vi.mocked(fetch).mockImplementation(async url => {
    const query = new URL(String(url), "http://test").searchParams;
    if (!query.get("path")) return Response.json(repo);
    if (query.get("path") === "src/manual.ts") return Response.json(query.get("whole") === "1" ? { lines: [{ kind: "context", text: "big", line: 1 }], capped: true } : { lines: [{ kind: "fold", text: "", count: 9000, line: 1 }, { kind: "add", text: "late edit", line: 9001 }] });
    return Response.json({ lines: [...Array.from({ length: 40 }, (_, index) => ({ kind: "context", text: `line ${index + 1}`, line: index + 1 })), { kind: "add", text: "edit", line: 41 }] });
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return { top: this.matches(".map-code") ? 100 : this.dataset.kind === "add" ? 900 : 0 } as DOMRect; });
  const rows = () => [...host.querySelectorAll(".map-code-row code, .map-gap")].map(row => row.textContent);
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([workers[0]]);
  expect(rows()).toHaveLength(41);
  expect(host.querySelector(".map-code")?.scrollTop).toBe(800);
  await act(async () => root.render(createElement(MapPane, { botId: "bot", active: false })));
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([workers[0]]);
  expect(host.querySelector(".map-code")?.scrollTop).toBe(800);
  expect(host.querySelector('.map-crumbs [role="radio"][aria-checked="true"]')?.textContent).toBe("Whole file");
  await click('[data-map-file="src/manual.ts"]');
  expect(rows()).toEqual(["9000 lines unchanged", "late edit", "Large diff folded"]);
  expect(reads().slice(-2).map(([url]) => new URL(String(url), "http://test").searchParams.get("whole"))).toEqual(["1", null]);
});

it("expands the file over the tree and brings the tree back with the same file, Up and Down still stepping", async () => {
  const key = (init: KeyboardEventInit) => act(async () => { host.querySelector(".map-expand")!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
  const path = () => host.querySelector("[data-map-path]")?.getAttribute("data-map-path");
  const expand = () => host.querySelector(".map-crumbs .map-expand");
  await act(async () => root.render(createElement(MapPane, { botId: "bot", maximized: true })));
  await emit([workers[0]]);
  expect(host.querySelector(".map-pane")?.hasAttribute("data-expanded")).toBe(false);
  expect(expand()?.getAttribute("aria-label")).toBe("Expand file");
  await click(".map-expand");
  expect(host.querySelector(".map-pane")?.hasAttribute("data-expanded")).toBe(true);
  expect(host.querySelector(".map-pane")?.hasAttribute("data-maximized")).toBe(true);
  expect(expand()?.getAttribute("aria-label")).toBe("Show tree");
  expect(expand()?.getAttribute("title")).toBe("Show tree");
  await key({ key: "ArrowDown" });
  expect(path()).toBe("src/manual.ts");
  expect(host.querySelector(".map-path b")?.textContent).toBe("manual.ts");
  await emit([{ ...workers[0], git: false, files: [] }]);
  expect(host.querySelector(".map-pane")?.hasAttribute("data-expanded")).toBe(false);
  expect(host.querySelector(".map-tree")).not.toBeNull();
  await emit([workers[0]]);
  expect(host.querySelector(".map-pane")?.hasAttribute("data-expanded")).toBe(true);
  await click(".map-expand");
  expect(host.querySelector(".map-pane")?.hasAttribute("data-expanded")).toBe(false);
  expect(host.querySelector('[aria-current="true"]')?.getAttribute("data-map-file")).toBe("src/manual.ts");
  expect(host.querySelector(".map-code [contenteditable], .map-code textarea, .map-code input")).toBeNull();
  await click(".map-expand");
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => { applyLocale("ko"); root.render(createElement(MapPane, { botId: "bot" })); });
  await emit([workers[0]]);
  expect(host.querySelector(".map-pane")?.hasAttribute("data-expanded")).toBe(false);
  expect(expand()?.getAttribute("aria-label")).toBe("파일 펼치기");
  await click(".map-expand");
  expect(expand()?.getAttribute("aria-label")).toBe("트리 보기");
});

it("shows one line and a labeled example on an empty Map, with no calls, until a worker starts", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  expect(host.querySelector(".map-example")).toBeNull();
  await emit([]);
  expect(host.querySelector(".map-empty")?.textContent).toBe("No live workers");
  expect(host.querySelector(".map-example > p")?.textContent).toBe("Your workers' changes show here live");
  expect(host.querySelector(".map-example small")?.textContent).toBe("Example");
  expect(host.querySelector(".map-example > div")?.hasAttribute("inert")).toBe(true);
  const file = () => host.querySelector(".map-example .map-code")?.textContent;
  const first = file();
  await act(async () => { vi.advanceTimersByTime(2400); });
  expect(file()).not.toBe(first);
  await act(async () => { vi.advanceTimersByTime(2400); });
  expect(file()).toBe(first);
  expect(fetch).not.toHaveBeenCalled();
  await emit([workers[0]]);
  expect(host.querySelector(".map-example")).toBeNull();
  vi.useRealTimers();
  await act(async () => { applyLocale("ko"); root.render(createElement(MapPane, { botId: "other" })); });
  await emit([]);
  expect(host.querySelector(".map-example")?.textContent).toContain("예시");
});

it("keeps the last tree and diff up, with no loading line, while a picked worker's own load", async () => {
  const pending: (() => void)[] = [];
  vi.mocked(fetch).mockImplementation(async url => {
    const query = new URL(String(url), "http://test").searchParams;
    if (query.get("worker") === "b") await new Promise<void>(done => pending.push(done));
    return query.get("path") ? Response.json({ lines: [{ kind: "add", text: `edit by ${query.get("worker")}`, line: 1 }] }) : Response.json({ ...repo, name: `repo-${query.get("worker")}` });
  });
  const rows = () => [...host.querySelectorAll(".map-code-row code")].map(row => row.textContent);
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit();
  await click(".map-worker");
  await click('[role="menuitemradio"]:nth-child(2)');
  expect(rows()).toEqual(["edit by a"]);
  await click(".map-worker");
  await click('[role="menuitemradio"]:nth-child(3)');
  expect(host.querySelector(".map-worker")?.textContent).toBe("BETA");
  expect(rows()).toEqual(["edit by a"]);
  expect(host.querySelector(".map-code")?.getAttribute("aria-busy")).toBe("true");
  expect(host.querySelector(".map-tree")).not.toBeNull();
  expect(host.textContent).not.toContain("Loading changes");
  await act(async () => { for (const done of pending.splice(0)) done(); });
  expect(rows()).toEqual(["edit by b"]);
  expect(host.querySelector(".map-code")?.getAttribute("aria-busy")).toBe("false");
  expect(host.querySelector(".map-where")?.textContent).toContain("repo-b");
});

it("marks the held diff busy when the picked worker edits the same path, until that worker's own diff lands", async () => {
  const pending: (() => void)[] = [];
  vi.mocked(fetch).mockImplementation(async url => {
    const query = new URL(String(url), "http://test").searchParams;
    if (query.get("worker") === "b" && query.get("path")) await new Promise<void>(done => pending.push(done));
    return query.get("path") ? Response.json({ lines: [{ kind: "add", text: `edit by ${query.get("worker")}`, line: 1 }] }) : Response.json(repo);
  });
  const rows = () => [...host.querySelectorAll(".map-code-row code")].map(row => row.textContent);
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([workers[0], { ...workers[1], path: "src/a.ts", files: [{ path: "src/a.ts", added: 1, removed: 0 }] }]);
  await click(".map-worker");
  await click('[role="menuitemradio"]:nth-child(2)');
  expect(rows()).toEqual(["edit by a"]);
  expect(host.querySelector(".map-code")?.getAttribute("aria-busy")).toBe("false");
  await click(".map-worker");
  await click('[role="menuitemradio"]:nth-child(3)');
  expect(host.querySelector(".map-worker")?.textContent).toBe("BETA");
  expect(host.querySelector(".map-crumbs")?.textContent).toContain("a.ts");
  expect(rows()).toEqual(["edit by a"]);
  expect(host.querySelector(".map-code")?.getAttribute("aria-busy")).toBe("true");
  await act(async () => { for (const done of pending.splice(0)) done(); });
  expect(rows()).toEqual(["edit by b"]);
  expect(host.querySelector(".map-code")?.getAttribute("aria-busy")).toBe("false");
});

it("pins the summary line so a short tree box cannot scroll it away", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "MapPane.css"), "utf8");
  expect(css).toContain(".map-where { position: sticky; top: -10px;");
  expect(css).toMatch(/\.map-top \{[^}]*overflow: auto; scroll-padding: 32px 0 14px;/);
});

it("lists a clash once per file with all its workers and caps the list with many workers", async () => {
  const shared = ["b.ts", "src/a.ts", "src/manual.ts", "src/z.ts", "README.md"];
  const team = Array.from({ length: 10 }, (_, i) => ({ ...workers[0], id: `w${i}`, nick: `W${i}`, editedAt: i, path: "src/a.ts", files: shared.map(path => ({ path, added: 1, removed: 0, ranges: [[i * 50 + 1, i * 50 + 1]] })) }));
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit(team);
  expect(host.querySelector(".map-where")?.textContent).toBe("10 workers · 5 of 6 files changed · 5 clasheswink / 10 workers");
  const rows = [...host.querySelectorAll(".map-tree-clash")].map(row => row.textContent);
  expect(rows).toEqual([
    `README.mdW0 + W1 + W2 + W3 + W4 + W5 + W6 + W7 + W8 + W9 · different lines`,
    `b.tsW0 + W1 + W2 + W3 + W4 + W5 + W6 + W7 + W8 + W9 · different lines`,
    `a.tsW0 + W1 + W2 + W3 + W4 + W5 + W6 + W7 + W8 + W9 · different lines`,
    "+2 more",
  ]);
});

it("reopens the stream from Retry when the snapshot failed, in the viewer and in the empty state", async () => {
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await act(async () => { stream.onmessage?.({ data: JSON.stringify({ workers, error: true }) }); });
  expect(host.querySelector(".map-code")?.textContent).toBe("Could not load changes Retry");
  await click(".map-code .map-empty button");
  expect(EventSource).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledOnce();
  await emit();
  expect(host.querySelector(".map-code")?.textContent).toContain("const edited = true;");
  await act(async () => { stream.onmessage?.({ data: JSON.stringify({ workers: [], error: true }) }); });
  expect(host.querySelector(".map-empty")?.textContent).toBe("Could not load changes Retry");
  await click(".map-empty button");
  expect(EventSource).toHaveBeenCalledTimes(3);
});

it("reconnects a stream the server refused", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await act(async () => { Object.assign(stream, { readyState: 2 }); stream.onerror?.(); });
  expect(host.textContent).toBe("Could not load changes Retry");
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(EventSource).toHaveBeenCalledTimes(2);
  await emit();
  expect(host.querySelector(".map-code")?.textContent).toContain("const edited = true;");
});

it("shows a failed worker's error on that worker alone, with a Retry that reopens the stream", async () => {
  vi.mocked(fetch).mockImplementation(async url => String(url).includes("/repo?") ? Response.json(new URL(String(url), "http://test").searchParams.get("worker") === "gone" ? { name: "", paths: [] } : repo) : Response.json({ lines: [{ kind: "add", text: "const edited = true;", line: 1 }] }));
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[0], error: true }, workers[1]]);
  expect(host.querySelector(".map-code")?.textContent).toContain("const edited = true;");
  await click(".map-worker");
  await click('[role="menuitemradio"]:nth-child(2)');
  expect(host.querySelector(".map-code")?.textContent).toBe("Could not load changes Retry");
  await click(".map-code .map-empty button");
  expect(EventSource).toHaveBeenCalledTimes(2);
  await emit([{ id: "gone", nick: "GONE", git: false, editedAt: 0, files: [], error: true }]);
  expect(host.querySelector(".map-where")?.textContent).toBe("0 files changedGONE");
  expect(host.querySelector(".map-top .map-empty")?.textContent).toBe("Could not load changes Retry");
  expect(host.querySelector(".map-tree")).toBeNull();
});

it("builds a team's tree from its first git worker and shows a remote worker as not a git folder alone", async () => {
  const asked = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/repo?")).map(([url]) => new URL(String(url), "http://test").searchParams.get("worker"));
  vi.mocked(fetch).mockImplementation(async url => String(url).includes("/repo?") ? Response.json(new URL(String(url), "http://test").searchParams.get("worker") === "r" ? { name: "", paths: [] } : repo) : Response.json({ lines: [] }));
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ id: "r", nick: "REMOTE", git: false, editedAt: 0, files: [] }, ...workers]);
  expect(asked()).toEqual(["a"]);
  expect(host.querySelector(".map-where")?.textContent).toBe("3 workers · 3 of 6 files changedwink / 3 workers");
  expect(host.querySelector(".map-tree-box b")?.textContent).toBe("wink");
  await click(".map-worker");
  await click('[role="menuitemradio"]:nth-child(2)');
  expect(host.querySelector(".map-where")?.textContent).toBe("Not a git folderREMOTE");
  expect(host.querySelector(".map-tree")).toBeNull();
});

it("says how many new files a capped worker left out", async () => {
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[0], more: 4800 }]);
  expect(host.querySelector(".map-where")?.textContent).toBe("Changed 2 of 6 files · +4,800 more fileswink / ALPHA");
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => { applyLocale("ko"); root.render(createElement(MapPane, { botId: "bot" })); });
  await emit([{ ...workers[0], more: 4800 }]);
  expect(host.querySelector(".map-where")?.textContent).toBe("파일 6개 중 2개 변경 · 외 파일 4,800개wink / ALPHA");
});

const posts: string[][] = [];
class Tokenizer {
  onmessage?: (event: { data: object }) => void;
  postMessage(data: { id: number; stop?: boolean; path: string; theme: string; code: string[]; removed: boolean[] }) {
    if (data.stop) return;
    posts.push(data.code);
    void tokenize(data.path, data.theme, data.code, data.removed, (from, tokens) => this.onmessage?.({ data: { id: data.id, from, tokens } })).then(done => this.onmessage?.({ data: { id: data.id, done } }));
  }
  terminate() {}
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(check()).toBe(true);
};
const source = [
  { kind: "context", text: "// sum two numbers", line: 1 },
  { kind: "remove", text: "const total = 1;", line: 2 },
  { kind: "add", text: 'const total = "two";', line: 2 },
  { kind: "context", text: "export type Total = number;", line: 3 },
];
const colors = () => Object.fromEntries([...host.querySelectorAll<HTMLElement>(".map-code-row code span")].map(span => [span.textContent, span.style.color.toUpperCase()]));
const openSource = async (path: string, lines: object[] = source) => {
  vi.mocked(fetch).mockImplementation(async url => String(url).includes("/repo?") ? Response.json(repo) : Response.json({ lines }));
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[0], path, files: [{ path, added: 1, removed: 1 }] }]);
};

it("colors code like VS Code's dark theme in both views and keeps the diff marks", async () => {
  await openSource("src/a.ts");
  await until(() => colors()["const"] !== undefined);
  expect(colors()).toMatchObject({ "// sum two numbers": "#6A9955", const: "#569CD6", '"two"': "#CE9178", "1": "#B5CEA8", Total: "#4EC9B0" });
  expect([...host.querySelectorAll(".map-code-row")].map(row => [row.getAttribute("data-kind"), row.querySelector("b")?.textContent, row.querySelector("code")?.textContent])).toEqual([["context", "", "// sum two numbers"], ["remove", "-", "const total = 1;"], ["add", "+", 'const total = "two";'], ["context", "", "export type Total = number;"]]);
  await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Changes only")!.click(); });
  expect(reads().at(-1)?.[0]).not.toContain("whole=1");
  expect(colors()).toMatchObject({ const: "#569CD6", '"two"': "#CE9178" });
  expect(host.querySelector('.map-code-row[data-kind="add"] b')?.textContent).toBe("+");
});

it("colors code like VS Code's light theme on a light skin", async () => {
  document.documentElement.dataset.skin = "atelier";
  try {
    await openSource("src/light.ts");
    await until(() => colors()["const"] !== undefined);
    expect(colors()).toMatchObject({ "// sum two numbers": "#008000", const: "#0000FF", '"two"': "#A31515", Total: "#267F99" });
  } finally { delete document.documentElement.dataset.skin; }
});

it("leaves a file in an unknown language as plain text", async () => {
  await openSource("notes.zzz");
  await until(() => posts.some(code => code.includes("// sum two numbers")) && !!host.querySelector(".map-code-row"));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(host.querySelector(".map-code-row code span")).toBeNull();
  expect(host.querySelector('.map-code-row[data-kind="add"] code')?.textContent).toBe('const total = "two";');
});

it("draws an already colored file at once from the cache without tokenizing it again", async () => {
  await openSource("src/again.ts");
  await until(() => colors()["const"] !== undefined);
  const sent = posts.length;
  await act(async () => root.unmount());
  root = createRoot(host);
  await openSource("src/again.ts");
  expect(colors()).toMatchObject({ const: "#569CD6", '"two"': "#CE9178" });
  expect(posts.length).toBe(sent);
});

it("colors a removed line inside an unchanged comment as a comment", async () => {
  await openSource("src/inside.ts", [{ kind: "context", text: "/* notes", line: 1 }, { kind: "remove", text: "old note", line: 2 }, { kind: "add", text: "new note", line: 2 }, { kind: "context", text: "*/", line: 3 }]);
  await until(() => !!host.querySelector('.map-code-row[data-kind="remove"] code span'));
  const color = (kind: string) => host.querySelector<HTMLElement>(`.map-code-row[data-kind="${kind}"] code span`)?.style.color.toUpperCase();
  expect([color("remove"), color("add")]).toEqual(["#6A9955", "#6A9955"]);
});

it("puts a second drag line between the tree and the Git rows, hidden when no Git rows follow", async () => {
  vi.mocked(fetch).mockImplementation(async url => String(url).includes("/repo?") ? Response.json(repo) : String(url).includes("/flow?") ? Response.json({ commits: [] }) : Response.json({ lines: [] }));
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([workers[0]]);
  await act(async () => {});
  const order = [...host.querySelector(".map-pane")!.children].map(part => part.matches(".map-split") ? part.getAttribute("aria-label") : part.className);
  expect(order.slice(0, 6)).toEqual(["map-head", "map-top", "Resize the file tree", "map-flow-rows", "Resize the code view", "map-crumbs"]);
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "MapPane.css"), "utf8");
  expect(css).toContain(".map-pane > .map-split[data-rows]:not(:has(+ .map-flow-rows)) { display: none; }");
  expect(css).toMatch(/\.map-pane > \.map-flow-rows \{[^}]*max-height: var\(--map-rows, 170px\);/);
});
