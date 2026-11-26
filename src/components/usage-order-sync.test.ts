// @vitest-environment happy-dom
// Two clients of one Wink, each with its own page and storage: the desktop app, a phone on the relay link,
// a phone on the Tailscale link. Each client loads its own copy of the app's modules.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usageBoardFixture, usageBoardNow } from "@/lib/usage-board.fixture";
import type { UsageBoard } from "@/lib/usage-board";
import { nextUsageOrder, parseUsageOrderBody } from "../../server/usage-order.ts";

type Status = { orders: Record<string, string[]>; seed?: "browser"; rev?: number } | null;
const h = vi.hoisted(() => ({ board: null as unknown, config: undefined as unknown, api: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: h.api,
  useStore: () => ({ state: { instances: [], bots: [], terminalPanes: {}, config: h.config }, dispatch: () => {}, refreshInstances: async () => {} }),
}));
vi.mock("@/lib/use-usage-board", () => ({ useUsageBoard: () => ({ board: h.board, status: "ready", pending: {}, failed: new Set() }) }));
vi.mock("@/lib/usage-auto-refresh", async (original) => ({ ...await original<typeof import("@/lib/usage-auto-refresh")>(), useAutoRefresh: () => {} }));

const LEGACY = "openmausbot.usageOrder.v1";
/** Wink's copy, and what PUT /api/usage-order does to it. */
let saved: Status;
function answer(path: string, init?: RequestInit) {
  if (path !== "/api/usage-order" || init?.method !== "PUT") return Promise.resolve({});
  saved = nextUsageOrder(saved ?? undefined, parseUsageOrderBody(JSON.parse(String(init.body)))) ?? saved;
  // the config frame every client gets
  h.config = { usageOrder: saved };
  return Promise.resolve({ usageOrder: saved });
}

const clients: { close(): Promise<void> }[] = [];
async function open({ storage = {}, desktop = false }: { storage?: Record<string, string>; desktop?: boolean } = {}) {
  vi.resetModules();
  localStorage.clear();
  for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  const app = window as { ogb?: unknown };
  if (desktop) app.ogb = { platform: "win32" };
  else delete app.ogb;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { I18nProvider, persistPreference } = await import("@/lib/i18n");
  const { UsageDesk } = await import("./UsageDesk");
  persistPreference("en");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const settle = () => React.act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
  const render = async () => {
    await React.act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(UsageDesk))));
    await settle();
  };
  await render();
  const local = { ...localStorage };
  const client = {
    host,
    local,
    rows: () => [...host.querySelectorAll('[data-usage-engine="claude"] [data-account-row]')].map((node) => node.getAttribute("data-account-row")),
    async move(id: string, key: "ArrowUp" | "ArrowDown") {
      await React.act(async () => {
        host.querySelector(`[data-account-row="${id}"]`)!.dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true }));
      });
      await settle();
    },
    /** Wink's config frame reaches this client. */
    receive: render,
    settle,
    close: () => React.act(async () => root.unmount()),
  };
  clients.push(client);
  return client;
}

let ids: string[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ now: usageBoardNow, toFake: ["Date"] });
  h.board = structuredClone(usageBoardFixture);
  ids = (h.board as UsageBoard).engines[0]!.accounts.map((account) => account.id);
  saved = null;
  h.config = { usageOrder: saved };
  h.api.mockReset().mockImplementation(answer);
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  document.body.replaceChildren();
  localStorage.clear();
  delete (window as { ogb?: unknown }).ogb;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows a drag from the desktop app on a phone that opens a new link with empty storage", async () => {
  const desktop = await open({ desktop: true });
  expect(desktop.rows()).toEqual(ids);
  await desktop.move(ids[0]!, "ArrowDown");
  const dragged = [ids[1], ids[0], ids[2]];
  expect(desktop.rows()).toEqual(dragged);
  const phone = await open();
  expect(phone.rows()).toEqual(dragged);
});

it("moves an open client's rows when another client drags", async () => {
  const desktop = await open({ desktop: true });
  const phone = await open();
  await phone.move(ids[2]!, "ArrowUp");
  const dragged = [ids[0], ids[2], ids[1]];
  expect(phone.rows()).toEqual(dragged);
  await desktop.receive();
  expect(desktop.rows()).toEqual(dragged);
});

it("sends the desktop app's old local order up once, then Wink's copy decides", async () => {
  const set = [ids[2]!, ids[0]!, ids[1]!];
  const desktop = await open({ desktop: true, storage: { [LEGACY]: JSON.stringify({ claude: set }) } });
  expect(desktop.rows()).toEqual(set);
  expect(desktop.local[LEGACY]).toBeUndefined();
  const phone = await open();
  expect(phone.rows()).toEqual(set);
  // a later stale local copy on another link no longer decides
  const tailscale = await open({ storage: { [LEGACY]: JSON.stringify({ claude: ids }) } });
  expect(tailscale.rows()).toEqual(set);
  expect(tailscale.local[LEGACY]).toBeUndefined();
});

it("keeps the desktop app's old order over one a phone's old link sent first", async () => {
  const stale = [ids[1]!, ids[2]!, ids[0]!];
  const set = [ids[2]!, ids[0]!, ids[1]!];
  const phone = await open({ storage: { [LEGACY]: JSON.stringify({ claude: stale }) } });
  expect(phone.rows()).toEqual(stale);
  const desktop = await open({ desktop: true, storage: { [LEGACY]: JSON.stringify({ claude: set }) } });
  expect(desktop.rows()).toEqual(set);
  await phone.receive();
  expect(phone.rows()).toEqual(set);
});

it("keeps a drag made after a phone's old order went up, over the desktop app's older copy", async () => {
  const phone = await open({ storage: { [LEGACY]: JSON.stringify({ claude: [ids[1]!, ids[2]!, ids[0]!] }) } });
  await phone.move(ids[0]!, "ArrowUp");
  const dragged = [ids[1], ids[0], ids[2]];
  expect(phone.rows()).toEqual(dragged);
  const desktop = await open({ desktop: true, storage: { [LEGACY]: JSON.stringify({ claude: [ids[2]!, ids[0]!, ids[1]!] }) } });
  expect(desktop.rows()).toEqual(dragged);
});

/** Wink takes each save at once; its reply and config frame wait until the test lets each one through. */
function holdReplies() {
  const held: (() => void)[] = [];
  const frames: unknown[] = [];
  h.api.mockImplementation((path: string, init?: RequestInit) => {
    const shown = h.config;
    const reply = answer(path, init);
    frames.push(h.config);
    h.config = shown;
    return new Promise((resolve) => held.push(() => resolve(reply)));
  });
  return { held, frames };
}

it("keeps a newer drag when an older drag's config frame arrives last", async () => {
  const desktop = await open({ desktop: true });
  const { held, frames } = holdReplies();
  await desktop.move(ids[0]!, "ArrowDown");
  await desktop.move(ids[0]!, "ArrowDown");
  const newer = [ids[1], ids[2], ids[0]];
  expect(desktop.rows()).toEqual(newer);
  while (held.length) {
    held.pop()!();
    await desktop.settle();
  }
  for (const frame of frames) {
    h.config = frame;
    await desktop.receive();
  }
  expect(desktop.rows()).toEqual(newer);
  h.config = frames[0];
  await desktop.receive();
  expect(desktop.rows()).toEqual(newer);
});

it("shows another client's newer order once this client's own save settles", async () => {
  const desktop = await open({ desktop: true });
  const phone = await open();
  const { held } = holdReplies();
  await desktop.move(ids[0]!, "ArrowDown");
  h.api.mockImplementation(answer);
  await phone.move(ids[2]!, "ArrowUp");
  const newer = [ids[0], ids[2], ids[1]];
  await desktop.receive();
  held[0]!();
  await desktop.settle();
  expect(desktop.rows()).toEqual(newer);
});

it("keeps the newer of two quick drags whatever order Wink takes their requests in", async () => {
  const desktop = await open({ desktop: true });
  const waiting: (() => void)[] = [];
  h.api.mockImplementation((path: string, init?: RequestInit) => new Promise((resolve) => waiting.push(() => resolve(answer(path, init)))));
  await desktop.move(ids[0]!, "ArrowDown");
  await desktop.move(ids[0]!, "ArrowDown");
  const newer = [ids[1], ids[2], ids[0]];
  while (waiting.length) {
    waiting.pop()!();
    await desktop.settle();
  }
  expect(saved?.orders.claude).toEqual(newer);
  expect(desktop.rows()).toEqual(newer);
});
