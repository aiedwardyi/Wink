// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { applySkin } from "@/lib/skins";
import { StoreProvider, useStore, type Bot, type InstanceInfo } from "@/state/store";

import { ChatView } from "./ChatView";

// SAFETY: React reads this flag off globalThis at act() time; the DOM lib does not declare it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: InstanceInfo = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  displayName: "Claude",
  snapshot: { state: "available", authenticated: false, authChecked: true },
  models: { default: "claude-opus", options: [{ id: "claude-opus", label: "Claude Opus" }] },
};

const main: InstanceInfo = {
  ...base,
  instanceId: "acct_main",
  accountOf: "claude",
  accountMain: true,
  accountState: "ready",
  snapshot: { state: "available", authenticated: true, authChecked: true, account: "me@example.com" },
};

const bot: Bot = {
  id: "a",
  threadId: "thread-a",
  name: "NBS",
  title: "",
  description: "",
  color: "blue",
  notifications: false,
  unread: false,
  busy: false,
  activity: "idle",
  cwd: "/repo",
  modelSelection: { instanceId: "claude", model: "claude-opus", effort: "high" },
  messages: [{ id: "q", at: Date.UTC(2026, 10, 17, 7) - 60_000, role: "user", kind: "text", text: "Hi" }],
};

const SIGN_IN = "NBS can answer once you're signed in.";

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  applySkin("precision");
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(bot: Bot, instances: InstanceInfo[]) {
  applyLocale("en");
  applySkin("precision");
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class {
    close() {}
  });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let store: ReturnType<typeof useStore>;
  function Harness() {
    store = useStore();
    return createElement(ChatView, { bot });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Harness))));
  await act(async () => store.dispatch({ type: "instances", instances }));
  return { host, dispatch: store!.dispatch };
}

describe("ChatView sign-in card follows the account the bot runs on", () => {
  it("hides the card when the base profile is signed out but Main is signed in", async () => {
    const { host } = await render(bot, [base, main]);
    expect(host.textContent).not.toContain(SIGN_IN);
  });

  it("hides the card when only spare accounts are signed out", async () => {
    const spare = (instanceId: string, authenticated: boolean): InstanceInfo => ({ ...main, instanceId, accountMain: false, snapshot: { state: "available", authenticated, authChecked: true } });
    const { host } = await render(bot, [base, spare("acct_getwinkdev", true), spare("acct_spare_out", false), main]);
    expect(host.textContent).not.toContain(SIGN_IN);
  });

  it("hides the card while the bot is mid-turn", async () => {
    const { host } = await render({ ...bot, busy: true, activity: "working" }, [base]);
    expect(host.textContent).not.toContain(SIGN_IN);
  });

  it("shows the card when Main itself is signed out", async () => {
    const { host } = await render(bot, [{ ...base, snapshot: { ...main.snapshot } }, { ...main, snapshot: { state: "available", authenticated: false, authChecked: true } }]);
    expect(host.textContent).toContain(SIGN_IN);
  });

  it("shows the card for a signed-out engine with no accounts", async () => {
    const { host } = await render(bot, [base]);
    expect(host.textContent).toContain(SIGN_IN);
  });
});
