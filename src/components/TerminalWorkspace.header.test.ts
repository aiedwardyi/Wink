import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { applyLocale, detectLocale } from "@/lib/i18n";
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Header checks do not need the live store.
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: {}, dispatch: vi.fn() }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- The DOM harness has no canvas.
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options = {};
  cols = 80;
  rows = 24;
  loadAddon() {}
  open() {}
  focus() {}
  dispose() {}
  refresh() {}
  resize() {}
  write(_data: string, done?: () => void) { done?.(); }
  onData() { return { dispose() {} }; }
  onBinary() { return { dispose() {} }; }
  attachCustomKeyEventHandler() {}
} }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Sizing is checked in the browser.
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Header checks do not need link detection.
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class { dispose() {} } }));

import { TerminalWorkspace, lastViewedPanes } from "./TerminalWorkspace";

let root: ReturnType<typeof createRoot>;
let host: HTMLElement;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  delete window.ogb;
  lastViewedPanes.clear();
  applyLocale("en");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(exited = false) {
  const close = vi.fn(async () => {});
  const listeners: Array<(event: { id: string; exitCode: number }) => void> = [];
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: {
    close,
    readBot: async () => ({ panes: [{ sessionId: "worker-1", label: "Sol | GPT-5.4 | high", exited, main: false }] }),
    open: async (input: { sessionId?: string }) => ({ id: input.sessionId ?? "main", cwd: "C:\\work", shell: "pwsh.exe", output: "", seq: 0, exitCode: exited && input.sessionId ? 0 : null }),
    resize: async () => {},
    onData: () => () => {},
    onExit: (cb: typeof listeners[number]) => { listeners.push(cb); return () => {}; },
  } } });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const props = {
    bot: { id: "bot-1", name: "Desk", cwd: "C:\\work" }, visible: true, focusBlocked: false, onClose: vi.fn(),
  };
  await act(async () => root.render(createElement(TerminalWorkspace, props)));
  await act(async () => { await Promise.resolve(); });
  return {
    close,
    pickWorker: async () => {
      await act(async () => host.querySelector<HTMLButtonElement>("header [data-worker-strip]")!.click());
      const row = [...host.querySelectorAll<HTMLButtonElement>("[data-worker-list] li button")].find((button) => button.querySelector("span.truncate.font-medium")?.textContent === "Sol")!;
      await act(async () => row.click());
    },
    exit: async () => act(async () => listeners.forEach((cb) => cb({ id: "worker-1", exitCode: 0 }))),
    main: async () => act(async () => root.render(createElement(TerminalWorkspace, { ...props, paneFocus: { sessionId: null } }))),
  };
}

const closeButton = () => host.querySelector<HTMLButtonElement>('header button[aria-label="Close pane"], header button[aria-label="창 닫기"]')!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-describedby]');
const dialogButton = (label: string) => [...dialog()!.querySelectorAll("button")].find((button) => button.textContent === label)!;

async function finishClosing(panel: HTMLElement) {
  expect(panel.parentElement?.getAttribute("data-closing")).toBe("true");
  expect(panel.parentElement?.hasAttribute("inert")).toBe(true);
  expect(panel.hasAttribute("role")).toBe(false);
  await act(async () => vi.advanceTimersByTime(PRESENCE_EXIT_MS - 1));
  expect(panel.isConnected).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(panel.isConnected).toBe(false);
}

it.each(["en", "ko-KR"])("confirms a running pane, keeps it on Cancel and Escape, then closes it in %s", async (locale) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  applyLocale(detectLocale(locale));
  const { close, pickWorker } = await mount();
  await pickWorker();
  await act(async () => closeButton().click());
  expect(close).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain(locale === "en" ? "Close this pane?" : "이 창을 닫을까요?");
  expect(dialog()?.textContent).toContain(locale === "en" ? "Sol is still running. Closing stops it." : "Sol 작업이 아직 실행 중이에요. 닫으면 중지돼요.");
  const cancel = locale === "en" ? "Cancel" : "취소";
  expect(document.activeElement).toBe(dialogButton(cancel));
  const cancelled = dialog()!;
  await act(async () => dialogButton(cancel).click());
  expect(dialog()).toBeNull();
  await finishClosing(cancelled);
  expect(closeButton()).not.toBeNull();
  expect(close).not.toHaveBeenCalled();
  await act(async () => closeButton().click());
  const escaped = dialog()!;
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(dialog()).toBeNull();
  await finishClosing(escaped);
  expect(close).not.toHaveBeenCalled();
  await act(async () => closeButton().click());
  const confirmed = dialog()!;
  await act(async () => dialogButton(locale === "en" ? "Close pane" : "창 닫기").click());
  expect(close).toHaveBeenCalledExactlyOnceWith("worker-1");
  expect(closeButton()).toBeNull();
  await finishClosing(confirmed);
});

it("confirms the original worker if the selected pane changes", async () => {
  const { close, main, pickWorker } = await mount();
  await pickWorker();
  await act(async () => closeButton().click());
  await main();
  expect(dialog()?.textContent).toContain("Sol is still running.");
  await act(async () => dialogButton("Close pane").click());
  expect(close).toHaveBeenCalledExactlyOnceWith("worker-1");
});

it.each(["seed", "event"])("closes an ended pane immediately after %s", async (source) => {
  const { close, exit, pickWorker } = await mount(source === "seed");
  await pickWorker();
  if (source === "event") await exit();
  await act(async () => closeButton().click());
  expect(dialog()).toBeNull();
  expect(close).toHaveBeenCalledExactlyOnceWith("worker-1");
});

it("gives all four header controls the same hover classes", async () => {
  const { pickWorker } = await mount();
  const mainControls = [...host.querySelectorAll<HTMLButtonElement>("header button")];
  expect(mainControls).toHaveLength(3);
  await pickWorker();
  const controls = [...host.querySelectorAll<HTMLButtonElement>("header button")].filter((control) => !control.closest("[data-closing]"));
  expect(controls).toHaveLength(4);
  const treatment = (control: HTMLElement) => [...control.classList].filter((value) => /^(hover:|transition-)/.test(value)).sort();
  for (const control of [...mainControls, ...controls]) expect(treatment(control)).toEqual(["hover:bg-raised", "hover:text-ink"]);
});
