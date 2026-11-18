// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount() {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { PendingQuestionPanel } = await import("./PendingQuestion");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  cleanup = async () => { await act(async () => root.unmount()); host.remove(); };
  await act(async () => root.render(createElement(PendingQuestionPanel, {
    message: { id: "reload-card", at: 1, role: "bot", kind: "options", card: { title: "Question", subtitle: "Which region?", options: ["Seoul", "Tokyo"], askUser: true } },
    askerName: "Ada", count: 1, onPick: () => {}, onDismiss: () => {},
  })));
  return { host, act };
}

it("keeps a folded question folded after a page reload", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const first = await mount();
  await first.act(async () => first.host.querySelector<HTMLButtonElement>('button[aria-label="Fold question"]')!.click());
  await cleanup?.();
  vi.resetModules();
  const second = await mount();
  expect(second.host.querySelector('[role="region"][data-pending-question]')).toBeNull();
  expect(second.host.querySelector("[data-question-row]")).not.toBeNull();
});
