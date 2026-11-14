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

it("draws each stage from the worker's git and PR and opens GitHub on click", async () => {
  await render();
  expect(calls()).toEqual(["/api/bots/bot/map/flow?worker=a"]);
  const stages = [...host.querySelectorAll<HTMLElement>(".map-flow-stage")];
  expect(stages.map(stage => [stage.dataset.k, stage.hasAttribute("data-on"), stage.dataset.tone ?? ""])).toEqual([
    ["commit", true, ""], ["push", true, ""], ["pr", true, "open"], ["checks", false, "run"], ["review", true, "run"], ["merge", false, ""],
  ]);
  expect(stages.map(stage => stage.querySelector("b")?.textContent)).toEqual(["2 commits", "Pushed", "PR #1529", "Checks", "Review", "Merged"]);
  expect(stages.map(stage => stage.querySelector("small")?.textContent)).toEqual(["1404479", "2 of 2", "open", "1 running", "claude · 2 open", "not yet"]);
  const checks = host.querySelector<HTMLAnchorElement>('[data-k="checks"]')!;
  expect(checks.getAttribute("href")).toBe("https://github.com/o/r/pull/1529/checks");
  expect(checks.getAttribute("target")).toBe("_blank");
  expect(checks.getAttribute("rel")).toBe("noreferrer");
  await act(async () => { host.querySelector('[data-k="commit"]')!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })); });
  expect(host.querySelector(".map-flow-tip")?.textContent).toContain("1404479 fix: arrow points at its square");
});

it("shows the detail on a long press without opening the link", async () => {
  await render();
  const checks = host.querySelector<HTMLAnchorElement>('[data-k="checks"]')!;
  await act(async () => { checks.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })); });
  await tick(500);
  expect(host.querySelector(".map-flow-tip")?.textContent).toContain("Running: vitest 1");
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => { checks.dispatchEvent(click); });
  expect(click.defaultPrevented).toBe(true);
});

it("ends at the last true stage when gh is signed out or there is no PR", async () => {
  flows.a = flow({ pr: null });
  await render();
  expect([...host.querySelectorAll<HTMLElement>(".map-flow-stage")].map(stage => stage.dataset.k)).toEqual(["commit", "push"]);
  expect(host.querySelector(".map-flow-stage:last-child")?.hasAttribute("data-end")).toBe(true);
  expect(host.textContent).not.toMatch(/error|could not|sign/i);
  flows.a = flow({ pr: null, pushed: 0, web: undefined });
  await tick(30_000);
  expect([...host.querySelectorAll<HTMLElement>(".map-flow-stage")].map(stage => stage.dataset.k)).toEqual(["commit"]);
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
  expect(host.querySelector('[data-k="merge"] [data-join]') !== null).toBe(true);
  await tick(120_000);
  expect(fetch).toHaveBeenCalledTimes(5);
});

it("slants the branch off main and back on straight lines and fills it as the PR moves along", async () => {
  const fills = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)].map(item => Number(item.style.getPropertyValue("--fill")));
  const slants = () => [...host.querySelectorAll(".map-flow-rise path, .map-flow-join path")].map(path => path.getAttribute("d"));
  flows.a = flow({ pr: null, pushed: 1 });
  await render();
  expect(fills(".map-flow-stage")).toEqual([1, .5]);
  flows.a = flow({ pr: pr({ reviews: [], threads: 0 }) });
  await tick(30_000);
  expect(fills(".map-flow-stage")).toEqual([1, 1, 1, .5, 0, 0]);
  flows.a = flow({ pr: pr({ state: "merged", checks: [{ name: "typecheck", state: "pass" }] }) });
  await tick(30_000);
  expect(fills(".map-flow-stage")).toEqual([1, 1, 1, 1, 1, 1]);
  expect(slants()).toHaveLength(2);
  flows = { a: flows.a, b: flow({ pr: pr({ number: 1531, checks: [{ name: "lint", state: "fail" }, { name: "vitest", state: "pending" }] }) }), c: flow({ pr: null, pushed: 1 }) };
  await render({ workers: [worker("a", "ALPHA"), worker("b", "BETA"), worker("c", "GAMMA")], all: true });
  expect(fills(".map-flow-thread")).toEqual([5 / 6, 1, .25]);
  expect(slants()).toHaveLength(4);
  expect(slants().join(" ")).not.toMatch(/[CQSATcqsat]/);
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
  expect(rows.map(row => row.querySelector("small")?.textContent)).toEqual(["#1531 · 2개 실패", "#1529 병합됨", "2개 중 1개 푸시"]);
  expect(rows[0].style.getPropertyValue("--flow-line")).toMatch(/^light-dark\(/);
  expect(new Set(rows.map(row => row.style.getPropertyValue("--flow-line"))).size).toBe(3);
  expect(rows[0].getAttribute("href")).toBe("https://github.com/o/r/pull/1529");
});
