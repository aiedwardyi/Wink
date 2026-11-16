// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type Message } from "@/state/store";

import { ChatView } from "./ChatView";

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Every mounted row is rendered, parsed and highlighted again on each switch.
const SWITCH_ROW_BUDGET = 40;

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const code = "```ts\nexport function total(items: number[]): number {\n  return items.reduce((sum, item) => sum + item, 0);\n}\n```";

// ADEMark A11: one prompt, 1,000 short steps each followed by a Read, a code block every fifth step.
function longThread(): Message[] {
  const rows: Message[] = [{ id: "ask", at: 1, role: "user", kind: "text", text: "replay:long-2000" }];
  for (let i = 1; i <= 1000; i++) {
    rows.push({ id: `t${i}`, at: 2 * i, role: "bot", kind: "text", text: `Step ${i} of 1000. I read src/invoices.ts.${i % 5 === 0 ? `\n\n${code}` : ""}` });
    rows.push({ id: `r${i}`, at: 2 * i + 1, role: "bot", kind: "activity", tool: { name: "Read", summary: "src/invoices.ts", ok: true } });
  }
  rows.push({ id: "end", at: 3000, role: "bot", kind: "text", text: "LONGTHREAD-END. Every line read." });
  return rows;
}

const bot = (id: string, messages: Message[]) => ({
  id, threadId: `thread-${id}`, name: id, title: "", description: "", notifications: false,
  color: "iris", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages, hasMore: false,
}) as unknown as Bot;

const short = bot("Short", [
  { id: "s1", at: 1, role: "user", kind: "text", text: "check the build log" },
  { id: "s2", at: 2, role: "bot", kind: "text", text: "The build passed." },
]);
const long = bot("Long", longThread());

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ChatView switch tail", () => {
  it("switching to a 1,000-step thread mounts only its newest rows, ending on the last one", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const show = (current: Bot) => act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: current }))));
    try {
      await show(short);
      for (let i = 0; i < 2; i++) {
        await show(long);
        const rows = host.querySelectorAll("[data-orbit-message]");
        expect(rows.length).toBeLessThanOrEqual(SWITCH_ROW_BUDGET);
        expect(rows[rows.length - 1]!.textContent).toContain("LONGTHREAD-END");
        expect(host.querySelectorAll("pre").length).toBeLessThanOrEqual(SWITCH_ROW_BUDGET / 5);
        await show(short);
        expect(host.querySelectorAll("[data-orbit-message]")).toHaveLength(2);
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
