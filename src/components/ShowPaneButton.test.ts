// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import { translate } from "@/lib/i18n";
import { sidebarWorkerStatus } from "@/lib/worker-status";
import { workerRuns } from "@/lib/worker-runs";
import type { Message } from "@/state/store";
import { saveSidebarSide } from "@/lib/sidebar-preferences";
import { closeShow, showItem, showMedia, showWorkers, useMediaThread, useShowItem, useWorkersThread } from "@/lib/show-pane";
import { closeVerifyWatch, openVerifyWatch, useVerifyWatch } from "@/lib/verify-watch";
import { ShowPaneButton } from "./ShowPaneButton";
import type { WorkerSource } from "./WorkerRows";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
let state: unknown[] = [];

let workers: WorkerSource | undefined;
let crew: string | null = null;

function Probe({ threadId }: { threadId: string }) {
  state = [useShowItem()?.path ?? null, useMediaThread(), Boolean(useVerifyWatch())];
  crew = useWorkersThread();
  return createElement(ShowPaneButton, { threadId, workers });
}

beforeEach(() => {
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => { workers = undefined; act(() => root.unmount()); host.remove(); act(() => { closeShow(); closeVerifyWatch(); }); applyLocale("en"); saveSidebarSide("left"); vi.restoreAllMocks(); });

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

it("keeps one worker shortcut when the open pane has its own toggle", async () => {
  document.body.append(host);
  workers = { name: "Ada", runs: [], onOpenTerminal: () => {} };
  let crew: string | null = null;
  function Pair() {
    crew = useWorkersThread();
    return createElement("div", null,
      createElement(ShowPaneButton, { threadId: "b6", workers }),
      createElement("div", { "data-side-panel": "" }, createElement(ShowPaneButton, { threadId: "b6", workers, inPane: true })),
    );
  }
  await act(async () => root.render(createElement(Pair)));
  await act(async () => showWorkers("b6"));
  const buttons = host.querySelectorAll("[data-show-pane-button]");
  expect(buttons[0].classList.contains("md:hidden")).toBe(true);
  expect(buttons[1].classList.contains("md:hidden")).toBe(false);
  const header = buttons[0] as HTMLButtonElement;
  const focus = vi.spyOn(header, "focus").mockImplementation(() => { expect(header.getAttribute("aria-pressed")).toBe("false"); });
  (buttons[1] as HTMLButtonElement).focus();
  await act(async () => window.dispatchEvent(new Event("orbit:toggle-worker-menu")));
  expect(crew).toBeNull();
  expect(focus).toHaveBeenCalledOnce();
});

it("speaks Korean", async () => {
  applyLocale("ko");
  await render("b4");
  expect(host.querySelector("button")!.title).toBe("보기와 미디어");
});

it("badge number is every open worker, the same number the sidebar line says", async () => {
  const pane = (i: number) => String(i).padStart(8, "0");
  const launch = (i: number): Message => ({ id: `l${i}`, at: i * 2 + 1, role: "bot", kind: "launch", text: `Launched W${i} | Opus 5.5 | high\nSession: ${pane(i)}-1` });
  const done = (i: number): Message => ({ id: `d${i}`, at: i * 2 + 2, role: "bot", kind: "note", text: `[pane ${pane(i)}] [W${i} | Opus 5.5 | high] from Ada (ada): DONE W${i} branch=x sha=y dirty=no` });
  const messages = Array.from({ length: 27 }, (_, i) => (i >= 19 ? [launch(i), done(i)] : [launch(i)])).flat();
  const runs = workerRuns(messages).map((run) => ({ run, state: run.state }));
  expect(runs.filter(({ state }) => state === "working")).toHaveLength(19);
  workers = { name: "Ada", runs, livePanes: new Set(runs.map(({ run }) => run.sessionId!)) };
  await render("b5");
  const labels = Array.from({ length: 27 }, (_, i) => `W${i} | Opus 5.5 | high`);
  expect(sidebarWorkerStatus(messages, labels, (key, vars) => translate("en", key, vars))).toBe("27 workers");
  expect(host.querySelector("[data-worker-badge]")?.textContent).toBe("27");
});

it.each([["BLOCKED", "waiting", "bg-warning text-app"], ["FAIL", "failed", "bg-danger"]] as const)("badge number takes the %s state's fill and ink while another worker runs", async (word, shown, classes) => {
  const launch = (i: number): Message => ({ id: `l${i}`, at: i * 2 + 1, role: "bot", kind: "launch", text: `Launched W${i} | Opus 5.5 | high\nSession: ${String(i).padStart(8, "0")}-1` });
  const note: Message = { id: "n1", at: 10, role: "bot", kind: "note", text: `[pane 00000001] [W1 | Opus 5.5 | high] from Ada (ada): ${word} W1 branch=x sha=y dirty=no\nstuck` };
  const runs = workerRuns([launch(1), launch(2), note]).map((run) => ({ run, state: run.state }));
  workers = { name: "Ada", runs, livePanes: new Set(runs.map(({ run }) => run.sessionId!)) };
  await render("b6");
  const badge = host.querySelector("[data-worker-badge]")!;
  expect(badge.getAttribute("data-worker-state")).toBe(shown);
  expect(badge.textContent).toBe("2");
  expect(badge.className).toContain(classes);
});

it("reopens on the chat's last tab while no worker is listed, and on Workers once one is", async () => {
  workers = { name: "Ada", runs: [], livePanes: new Set(), onOpenTerminal: () => {} };
  await render("b7");
  await act(async () => showMedia("b7"));
  await press();
  await press();
  expect([state[1], crew]).toEqual(["b7", null]);
  await press();
  const launch: Message = { id: "l1", at: 1, role: "bot", kind: "launch", text: "Launched W1 | Opus 5.5 | high\nSession: 00000001-1" };
  const runs = workerRuns([launch]).map((run) => ({ run, state: run.state }));
  workers = { ...workers, runs, livePanes: new Set(["00000001-1"]) };
  await render("b7");
  await press();
  expect([state[1], crew]).toEqual([null, "b7"]);
});

it("reopens on Workers when it was the chat's last tab, with no worker listed", async () => {
  workers = { name: "Ada", runs: [], livePanes: new Set(), onOpenTerminal: () => {} };
  await render("b9");
  await act(async () => showWorkers("b9"));
  await press();
  expect(crew).toBeNull();
  await press();
  expect([state[1], crew]).toEqual([null, "b9"]);
});

it("keeps the Working badge and sidebar line for an open pane whose run is past the loaded page", async () => {
  workers = { name: "Ada", runs: [], livePanes: new Set(["00000009-1"]), paneLabels: new Map([["00000009-1", "OLD | Opus 5.5 | high"]]) };
  await render("b8");
  expect(host.querySelector("[data-worker-badge]")?.textContent).toBe("1");
  expect(sidebarWorkerStatus([], ["OLD | Opus 5.5 | high"], (key, vars) => translate("en", key, vars))).toBe("1 worker");
});
