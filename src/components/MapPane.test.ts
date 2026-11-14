// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MapPane } from "./MapPane";
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
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); applyLocale("en"); });

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

it("hops the pointer to the file just edited without covering its name, and shows the path when the worker left no note", async () => {
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[1], editedAt: Date.UTC(2026, 10, 13, 1, 16, 7) }]);
  const numbers = (element: HTMLElement) => element.style.transform.match(/-?[\d.]+/g)!.map(Number);
  const near = (path: string) => {
    const row = host.querySelector<HTMLElement>(`.map-tree-file[title="${path}"]`)!;
    const [x, y] = numbers(row.closest<HTMLElement>(".map-tree-n")!);
    const top = y + parseFloat(row.parentElement!.style.top) + parseFloat(row.style.top) + 17 / 2;
    const [px, py] = numbers(host.querySelector<HTMLElement>(".map-tree-pin")!);
    return { tip: px + 1.4, name: x + 14 + 13, gap: Math.abs(py + 0.7 - top) };
  };
  for (const path of ["b.ts", "src/a.ts"]) {
    if (path !== "b.ts") await emit([{ ...workers[1], editedAt: Date.UTC(2026, 10, 13, 1, 17), path, files: [...workers[1].files, { path, added: 2, removed: 0 }] }]);
    await vi.waitFor(() => {
      const { tip, name, gap } = near(path);
      expect(tip).toBeLessThan(name - 4);
      expect(gap).toBeLessThan(4);
    });
  }
  await emit([{ ...workers[1], editedAt: Date.UTC(2026, 10, 13, 1, 16, 7) }]);
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

it("opens only a file from the folders a folded folders box holds, never one under a visible box", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
  const dirs: [string, number][] = [["src", 20], ["big", 20], ["c1", 6], ["c2", 6], ["c3", 6], ["c4", 6], ["zeta-folder-long", 2]];
  const paths = dirs.flatMap(([dir, n]) => Array.from({ length: n }, (_, i) => `${dir}/f${i}.ts`));
  vi.mocked(fetch).mockImplementation(async url => String(url).includes("/repo?") ? Response.json({ name: "wink", paths }) : Response.json({ lines: [{ kind: "add", text: "x", line: 1 }] }));
  await act(async () => root.render(createElement(MapPane, { botId: "bot" })));
  await emit([{ ...workers[0], path: "src/f1.ts", files: ["src/f1.ts", "big/f2.ts", "zeta-folder-long/f1.ts"].map(path => ({ path, added: 1, removed: 0 })) }]);
  expect([...host.querySelectorAll("button.map-tree-box")].map(box => box.textContent)).toContain("big/20");
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
  await click(".map-whole");
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
  expect(host.querySelector(".map-whole")?.textContent).toBe("변경만");
  await click(".map-whole");
  expect(host.querySelector(".map-whole")?.textContent).toBe("전체 파일");
  expect(rows()).toEqual(["변경 없는 2줄", "edit in src/a.ts"]);
  await click("button.map-gap");
  expect(rows()).toEqual(["one", "two", "edit in src/a.ts"]);
  await click('[data-map-file="src/manual.ts"]');
  expect(rows()).toEqual(["변경 없는 2줄", "edit in src/manual.ts"]);
  await click(".map-whole");
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
  expect(host.querySelector(".map-whole")?.textContent).toBe("Changes only");
  await click('[data-map-file="src/manual.ts"]');
  expect(rows()).toEqual(["9000 lines unchanged", "late edit", "Large diff folded"]);
  expect(reads().slice(-2).map(([url]) => new URL(String(url), "http://test").searchParams.get("whole"))).toEqual(["1", null]);
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
