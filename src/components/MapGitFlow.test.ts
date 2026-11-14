// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MapFlow, MapPr } from "../../shared/map-flow";
import type { MapWorker } from "../../shared/map-pane";
import { applyLocale } from "@/lib/i18n";
import { mapWorkerSlots } from "@/lib/map-worker-colors";
import { MapGitFlow } from "./MapGitFlow";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
const worker = (id: string, nick: string, git = true): MapWorker => ({ id, nick, git, editedAt: 1, files: [] });
const pr = (over: Partial<MapPr> = {}): MapPr => ({ number: 1529, url: "https://github.com/o/r/pull/1529", title: "feat: arrow keys", into: "review-base", state: "open", checks: [{ name: "typecheck", state: "pass" }, { name: "vitest 1", state: "pending" }], reviews: [{ login: "claude", state: "commented" }], decision: "", threads: 2, ...over });
const flow = (over: Partial<MapFlow> = {}): MapFlow => ({ branch: "feat/map-keys", commits: [{ sha: "1404479aa", subject: "fix: arrow points at its square" }, { sha: "1137b98bb", subject: "fix: fold" }], total: 2, pushed: 2, web: "https://github.com/o/r", pr: pr(), ...over });
let flows: Record<string, MapFlow>;
const calls = () => vi.mocked(fetch).mock.calls.map(([url]) => String(url));
const render = (props: Partial<Parameters<typeof MapGitFlow>[0]> = {}) => act(async () => root.render(createElement(MapGitFlow, { base: "/api/bots/bot/map", workers: [worker("a", "ALPHA")], slots: mapWorkerSlots(new Map(), (props.workers ?? [worker("a", "ALPHA")]).map(item => item.id)), worker: "a", all: false, active: true, ...props })));
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flows = { a: flow() };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(flows[new URL(url, "http://x").searchParams.get("worker")!])));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); applyLocale("en"); });

const stops = () => [...host.querySelectorAll<HTMLElement>(".map-flow-row [data-k]")].map(stop => `${stop.dataset.k}:${stop.dataset.state ?? ""}`);
const words = () => [...host.querySelectorAll<HTMLElement>(".map-flow-row [data-k] > small")].map(word => word.textContent);
const edited = (...paths: string[]): MapWorker => ({ ...worker("a", "ALPHA"), files: paths.map(path => ({ path, added: 1, removed: 0 })) });
const fresh = { commits: [], total: 0, pushed: 0, web: undefined, pr: null };

it.each([
  ["no commits", worker("a", "ALPHA"), flow(fresh), "", ["code:", "commit:", "push:", "pr:", "checks:", "review:", "merge:"], "-1", "no commits yet"],
  ["coding", edited("src/a.ts"), flow(fresh), "", ["code:on", "commit:", "push:", "pr:", "checks:", "review:", "merge:"], "0", "no commits yet"],
  ["committed, not pushed", edited("src/a.ts"), flow({ pushed: 0, pr: null }), "", ["code:on", "commit:on", "push:", "pr:", "checks:", "review:", "merge:"], "1", "2 commits"],
  ["pushed", edited("src/a.ts"), flow({ pr: null }), "", ["code:on", "commit:on", "push:on", "pr:", "checks:", "review:", "merge:"], "2", "pushed 2 of 2"],
  ["PR open, checks running", edited("src/a.ts"), flow({ pr: pr({ reviews: [], threads: 0 }) }), "1 running", ["code:on", "commit:on", "push:on", "pr:on", "checks:run", "review:", "merge:"], "4", "#1529 · 1 running"],
  ["checks failing", edited("src/a.ts"), flow({ pr: pr({ reviews: [], threads: 0, checks: [{ name: "typecheck", state: "fail" }, { name: "lint", state: "pass" }] }) }), "1 fail", ["code:on", "commit:on", "push:on", "pr:on", "checks:bad", "review:", "merge:"], "4", "#1529 · 1 failing"],
  ["checks passed, in review", edited("src/a.ts"), flow({ pr: pr({ checks: [{ name: "typecheck", state: "pass" }] }) }), "passed", ["code:on", "commit:on", "push:on", "pr:on", "checks:ok", "review:half", "merge:"], "5", "#1529 · 2 open"],
  ["changes asked", edited("src/a.ts"), flow({ pr: pr({ checks: [{ name: "typecheck", state: "pass" }], decision: "changes", reviews: [{ login: "claude", state: "changes" }] }) }), "passed", ["code:on", "commit:on", "push:on", "pr:on", "checks:ok", "review:bad", "merge:"], "5", "#1529 · changes asked"],
  ["approved", edited("src/a.ts"), flow({ pr: pr({ checks: [{ name: "typecheck", state: "pass" }], decision: "approved", reviews: [{ login: "claude", state: "approved" }], threads: 0 }) }), "passed", ["code:on", "commit:on", "push:on", "pr:on", "checks:ok", "review:on", "merge:"], "5", "#1529 · approved"],
  ["merged", worker("a", "ALPHA"), flow({ pr: pr({ state: "merged", checks: [{ name: "typecheck", state: "pass" }], decision: "approved", threads: 0 }) }), "passed", ["code:on", "commit:on", "push:on", "pr:on", "checks:ok", "review:on", "merge:merged"], "6", "#1529 merged"],
  ["closed", worker("a", "ALPHA"), flow({ pr: pr({ state: "closed", checks: [], reviews: [], threads: 0 }) }), "", ["code:on", "commit:on", "push:on", "pr:on", "checks:", "review:", "merge:closed"], "3", "#1529 closed"],
] as const)("draws %s as stops on one straight line", async (_name, who, state, status, expected, reach, label) => {
  flows.a = state;
  await render({ workers: [who] });
  expect(stops()).toEqual(expected);
  expect(words()).toEqual(["Coding", "Commit", "Push", "PR", "Review", state.pr?.state === "closed" ? "Closed" : "Merged"]);
  expect(host.querySelector(".map-flow-box > b")?.textContent).toBe(`Checks${status}`);
  const line = host.querySelector<HTMLElement>(".map-flow-stops")!;
  expect(line.dataset.reach).toBe(reach);
  expect(line.dataset.fill).toBe(+reach < 0 ? undefined : +reach < 3 ? "claude" : +reach < 6 ? "open" : "merged");
  expect(line.querySelectorAll(":scope > i[data-on]").length).toBe(Math.max(0, +reach));
  expect(host.querySelector(".map-flow-end > small")?.textContent).toBe(label);
  expect(host.querySelector(".map-flow-dots, .map-flow-thread, .map-flow-rise, .map-flow-join, svg")).toBeNull();
});

it("puts a square per check in the checks box and the details in each stop's tip", async () => {
  flows.a = flow({ pr: pr({ checks: [{ name: "typecheck", state: "pass" }, { name: "vitest 1", state: "pending" }, { name: "lint", state: "fail" }, { name: "docs", state: "skip" }] }) });
  await render({ workers: [edited("src/a.ts")] });
  expect(calls()).toEqual(["/api/bots/bot/map/flow?worker=a"]);
  expect([...host.querySelectorAll<HTMLElement>(".map-flow-box i")].map(check => check.dataset.state)).toEqual(["pass", "pending", "fail"]);
  const hover = (key: string) => act(async () => { host.querySelector(`[data-k="${key}"]`)!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })); });
  await hover("commit");
  expect(host.querySelector(".map-flow-tip")?.textContent).toBe("2 commits1404479 fix: arrow points at its square1137b98 fix: fold");
  await hover("checks");
  expect(host.querySelector(".map-flow-tip")?.textContent).toBe("Failing: lint");
  await hover("code");
  expect(host.querySelector(".map-flow-tip")?.textContent).toBe("1 file changed");
  expect(host.querySelector(".map-flow-list .map-flow-tip")).toBeNull();
  expect(host.querySelector(".map-flow-rows > .map-flow-tip")).not.toBeNull();
  expect(host.querySelector(".map-flow-row")?.getAttribute("href")).toBe("https://github.com/o/r/pull/1529");
});

it("shows the detail on a long press without opening the link", async () => {
  await render();
  const checks = host.querySelector<HTMLElement>('[data-k="checks"]')!;
  await act(async () => { checks.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })); });
  await tick(500);
  expect(host.querySelector(".map-flow-tip")?.textContent).toContain("Running: vitest 1");
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => { checks.dispatchEvent(click); });
  expect(click.defaultPrevented).toBe(true);
});

it("shows the row's details on keyboard focus", async () => {
  await render();
  await act(async () => { host.querySelector<HTMLElement>(".map-flow-row")!.focus(); });
  expect([...host.querySelectorAll(".map-flow-tip p")].map(line => line.textContent)).toEqual(["Running: vitest 1", "claude · commented", "2 open threads"]);
  await act(async () => { host.querySelector<HTMLElement>(".map-flow-row")!.blur(); });
  expect(host.querySelector(".map-flow-tip")).toBeNull();
});

it("counts the files another worker is also editing, hidden at 0", async () => {
  flows.b = flow({ pr: null });
  const a = { ...edited("src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"), id: "a", nick: "ALPHA" };
  const b = { ...edited("src/a.ts", "src/b.ts", "src/c.ts"), id: "b", nick: "BETA" };
  await render({ workers: [a, { ...b, files: [] }], all: true });
  expect(host.querySelector(".map-flow-clash")).toBeNull();
  await render({ workers: [a, b], all: true });
  expect([...host.querySelectorAll(".map-flow-clash")].map(clash => clash.textContent)).toEqual(["⚠ 3 files", "⚠ 3 files"]);
  await act(async () => { host.querySelector(".map-flow-clash")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })); });
  expect(host.querySelector(".map-flow-tip")?.textContent).toBe("Also edited by BETAsrc/a.tssrc/b.tssrc/c.ts");
});

it("hides with no git", async () => {
  await render({ workers: [worker("a", "ALPHA", false)] });
  expect(host.querySelector(".map-flow")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("polls every 30 s only while the tab is open and the PR is open", async () => {
  await render();
  expect(fetch).toHaveBeenCalledTimes(1);
  await tick(29_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  await tick(1_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  await render({ active: false });
  await tick(120_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  await render({ active: true });
  expect(fetch).toHaveBeenCalledTimes(3);
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  document.dispatchEvent(new Event("visibilitychange"));
  await tick(120_000);
  expect(fetch).toHaveBeenCalledTimes(3);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(fetch).toHaveBeenCalledTimes(4);
  flows.a = flow({ pr: pr({ state: "merged", mergedAt: Date.parse("2026-11-12T19:14:03Z"), checks: [{ name: "typecheck", state: "pass" }] }) });
  await tick(30_000);
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(host.querySelector('[data-k="merge"]')?.getAttribute("data-state")).toBe("merged");
  await tick(120_000);
  expect(fetch).toHaveBeenCalledTimes(5);
});

it("puts one row per worker in its color, failing CI first, in Korean too", async () => {
  applyLocale("ko");
  flows = {
    a: flow({ pr: pr({ state: "merged", checks: [{ name: "typecheck", state: "pass" }] }) }),
    b: flow({ pr: pr({ number: 1531, checks: [{ name: "typecheck", state: "fail" }, { name: "lint", state: "fail" }, { name: "vitest", state: "pass" }] }) }),
    c: flow({ pr: null, pushed: 1 }),
  };
  await render({ workers: [worker("a", "ALPHA"), worker("b", "BETA"), worker("c", "GAMMA"), worker("d", "DELTA", false)], all: true });
  const rows = [...host.querySelectorAll<HTMLElement>(".map-flow-row")];
  expect(rows.map(row => row.querySelector("b")?.textContent)).toEqual(["BETA", "ALPHA", "GAMMA"]);
  expect(rows.map(row => row.querySelector(".map-flow-end > small")?.textContent)).toEqual(["#1531 · 2개 실패", "#1529 병합됨", "2개 중 1개 푸시"]);
  expect([...rows[0].querySelectorAll("[data-k] > small")].map(word => word.textContent)).toEqual(["코딩", "커밋", "푸시", "PR", "리뷰", "병합"]);
  expect(rows[0].querySelector(".map-flow-box > b")?.textContent).toBe("체크2개 실패");
  expect(rows[0].style.getPropertyValue("--flow-line")).toMatch(/^light-dark\(/);
  expect(new Set(rows.map(row => row.style.getPropertyValue("--flow-line"))).size).toBe(3);
  expect(rows[0].getAttribute("href")).toBe("https://github.com/o/r/pull/1529");
});
