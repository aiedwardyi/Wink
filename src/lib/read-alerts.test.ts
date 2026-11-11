import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeReadAlerts } from "./read-alerts";

afterEach(() => vi.unstubAllGlobals());

function installAlerts(alerts: Array<{ chat?: string; at?: number }>) {
  const shown = alerts.map((data) => ({ data, close: vi.fn() }));
  vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => ({ getNotifications: async () => shown }) } });
  return shown;
}

describe("closeReadAlerts", () => {
  it("closes alerts that arrived before their chat was read", async () => {
    const shown = installAlerts([{ chat: "b1", at: 5 }, { chat: "b1", at: 20 }, { chat: "b2", at: 5 }, { chat: "g1", at: 5 }, { chat: "g1" }, {}]);
    await closeReadAlerts(() => [
      { id: "b1", readAt: 10 },
      { id: "b2", unread: true, readAt: 10 },
      { id: "g1", readAt: 10 },
    ]);
    expect(shown.map((alert) => alert.close.mock.calls.length)).toEqual([1, 0, 0, 1, 1, 0]);
  });

  it("skips the read state when no alert is shown", async () => {
    installAlerts([]);
    const chats = vi.fn(async () => []);
    await closeReadAlerts(chats);
    expect(chats).not.toHaveBeenCalled();
  });

  it("closes a push delivered after the visible page already swept its read state", async () => {
    const shown = installAlerts([]);
    const latestState = { current: { bots: [{ id: "b1", readAt: 200 }], groups: [] } };
    await closeReadAlerts(() => latestState.current.bots);
    const messages = new EventTarget();
    Object.assign(navigator.serviceWorker, {
      addEventListener: messages.addEventListener.bind(messages),
      removeEventListener: messages.removeEventListener.bind(messages),
    });
    const app = ts.createSourceFile("App.tsx", readFileSync(new URL("../App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let effect = "";
    const find = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(app) === "useEffect" && node.arguments[0]?.getText(app).includes('"orbit-open"')) {
        effect = node.arguments[0].getText(app);
      }
      ts.forEachChild(node, find);
    };
    find(app);
    expect(effect).not.toBe("");
    const sweeps: Promise<void>[] = [];
    const sweep: typeof closeReadAlerts = (read) => {
      const pending = closeReadAlerts(read);
      sweeps.push(pending);
      return pending;
    };
    const mount = new Function("navigator", "window", "latestState", "closeReadAlerts", `return ${ts.transpile(`(${effect})`, { target: ts.ScriptTarget.ES2022 })};`);
    const cleanup = mount(navigator, {}, latestState, sweep)();
    const handlers: Record<string, (event: any) => void> = {};
    const self = {
      location: new URL("https://phone.test"),
      addEventListener: (type: string, handler: (event: any) => void) => (handlers[type] = handler),
      registration: {
        showNotification: async (_title: string, options: { data: { chat: string; at: number } }) => {
          await Promise.resolve();
          shown.push({ data: options.data, close: vi.fn() });
        },
      },
      clients: {
        matchAll: async ({ includeUncontrolled }: { includeUncontrolled?: boolean }) => includeUncontrolled
          ? [{ postMessage: (data: unknown) => messages.dispatchEvent(new MessageEvent("message", { data })) }]
          : [],
      },
    };
    new Function("self", readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"))(self);
    const waits: Promise<unknown>[] = [];
    try {
      handlers.push({ data: { json: () => ({ chat: "b1", at: 100 }) }, waitUntil: (pending: Promise<unknown>) => waits.push(pending) });
      await Promise.all(waits);
      await Promise.all(sweeps);
      expect(shown).toHaveLength(1);
      expect(shown[0].close).toHaveBeenCalledOnce();
    } finally {
      cleanup();
    }
  });
});
