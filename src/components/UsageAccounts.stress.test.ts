// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, persistPreference } from "@/lib/i18n";
import { StoreProvider, type InstanceInfo } from "@/state/store";
import { UsageSection } from "./UsageSection";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

type Of = "claude" | "codex";
const acct = (n: number) => `acct_00000000-0000-4000-8000-00000000000${n}`;
const PEOPLE: Array<[id: string, of: Of, name: string]> = [
  ["claude", "claude", "ada"], [acct(1), "claude", "bo"], [acct(2), "claude", "cy"], [acct(3), "claude", "dee"],
  ["codex", "codex", "eli"], [acct(4), "codex", "fay"],
];
const used = (id: string) => 11 + PEOPLE.findIndex(([each]) => each === id) * 13;
const email = (id: string) => `${PEOPLE.find(([each]) => each === id)![2]}@example.test`;
const engineOf = (id: string) => PEOPLE.find(([each]) => each === id)![1];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const ui = { clicks: 0, keys: 0 };

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = host = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mount(width: number, seed = 7) {
  const main: Record<Of, string> = { claude: "claude", codex: "codex" };
  const observedAt = new Date().toISOString();
  const resetsAt = Date.now() + 3_600_000;
  const view = () => PEOPLE.map(([id, of, name]) => ({
    instanceId: id, driverKind: of === "claude" ? "claudeAgent" : "codex", displayName: of === "claude" ? "Claude" : "Codex",
    accountOf: of, accountState: "ready", accountMain: main[of] === id,
    snapshot: { state: "available", authenticated: true, account: `${name}@example.test` },
    models: { default: "default", options: [] }, capabilities: { rateLimits: true }, canRefreshUsage: true,
    rateLimits: { observedAt, windows: [{ id: of === "claude" ? "five_hour" : "primary", windowMinutes: 300, usedPercent: used(id), resetsAt }] },
  }) as InstanceInfo);
  let next = seed;
  const random = (below: number) => (next = next * 48271 % 2147483647) % below;
  const held: Array<{ method: string; release: () => void }> = [];
  const posts: string[] = [];
  let manual = false;
  let inflight = 0;
  let frames = Promise.resolve();
  const push = () => FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "instances", instances: view() }), lastEventId: "" });
  const publish = () => {
    inflight += 1;
    frames = frames.then(() => sleep(random(40))).then(push).finally(() => { inflight -= 1; });
  };
  const reply = (method: string) => manual ? new Promise<void>((release) => held.push({ method, release })) : sleep(random(40));
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const sizes = [...query.matchAll(/\((max|min)-width:\s*([\d.]+)px\)/g)];
    const matches = sizes.length > 0 && sizes.every(([, side, px]) => side === "max" ? width <= Number(px) : width >= Number(px));
    return { matches, media: query, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList;
  });
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    if (path === "/api/bots?messages=200") return Response.json({ bots: [], groups: [], computerControl: {} });
    const target = method === "POST" ? /^\/api\/accounts\/([^/]+)\/default$/.exec(path)?.[1] : undefined;
    if (!target && !(method === "GET" && path.startsWith("/api/instances"))) return Response.json({ error: "not in this test" }, { status: 404 });
    inflight += 1;
    try {
      if (!target) {
        const instances = view();
        await reply(method);
        return Response.json({ instances });
      }
      const id = decodeURIComponent(target);
      main[engineOf(id)] = id;
      posts.push(id);
      if (!manual) publish();
      await reply(method);
      return Response.json({});
    } finally {
      inflight -= 1;
    }
  }));
  persistPreference("en");
  FakeEventSource.last = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(StoreProvider, null, createElement(I18nProvider, null, createElement(UsageSection))));
  await vi.waitFor(() => expect(FakeEventSource.last?.onmessage).toBeTypeOf("function"));
  FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c1" }), lastEventId: "" });
  await vi.waitFor(() => expect(new Set([...host!.querySelectorAll("[data-account-column]")].map((column) => column.parentElement)).size).toBe(2));
  const settled = async () => {
    for (let quiet = 0; quiet < 3;) {
      await sleep(20);
      quiet = inflight === 0 && held.length === 0 ? quiet + 1 : 0;
    }
  };
  await settled();
  return {
    main, posts, random, settled, push,
    phone: width < 768,
    manual: () => { manual = true; },
    take: (method: string) => vi.waitFor(() => {
      const index = held.findIndex((each) => each.method === method);
      if (index < 0) throw new Error(`no held ${method}`);
      return held.splice(index, 1)[0]!.release;
    }),
    elsewhere: (id: string) => {
      main[engineOf(id)] = id;
      posts.push(id);
      push();
    },
  };
}

const group = (of: Of) => [...host!.querySelectorAll("[data-account-column]")].map((column) => column.parentElement!)
  .find((each) => each.textContent!.includes(of === "claude" ? "Claude" : "Codex"))!;
const live = (of: Of) => group(of).querySelector('[data-account-column="other"] > div:not([inert]), [data-account-column="pages"] > div:not([inert])')!;
const trigger = (of: Of) => live(of).querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
const setAsMain = (of: Of) => [...live(of).querySelectorAll<HTMLButtonElement>("[data-account-head] button")].find((node) => node.textContent === "Set as Main");
const accountIn = (node: Element) => {
  const left = /5h: (\d+)% remaining/.exec(node.querySelector('[aria-label^="5h:"]')?.getAttribute("aria-label") ?? "")?.[1];
  return PEOPLE.find(([id]) => 100 - used(id) === Number(left))?.[0];
};
const tagged = (node: Element) => [...node.querySelectorAll("[data-account-head] span")].some((span) => !span.children.length && span.textContent === "Main" && !span.closest('[role="menu"]'));
function shown(of: Of) {
  const columns = [group(of).querySelector('[data-account-column="main"]'), ...group(of).querySelectorAll("[data-account-page]"), live(of)].filter((node) => node !== null);
  return {
    mains: columns.filter(tagged).map((node) => node.getAttribute("data-account-page") ?? accountIn(node)),
    viewed: accountIn(live(of)),
    trigger: trigger(of)?.getAttribute("aria-label") ?? null,
  };
}
function press(node: HTMLElement) {
  ui.clicks += 1;
  node.click();
}
function key(name: string) {
  const target = document.activeElement as HTMLElement;
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  ui.keys += 1;
  target.dispatchEvent(event);
  if (name === "Enter" && !event.defaultPrevented) target.click();
}
const menuItems = (of: Of) => [...group(of).querySelectorAll<HTMLButtonElement>('[role="menu"]:not([data-closing]) [role="menuitemradio"]')];
async function pick(of: Of, id: string) {
  press(trigger(of)!);
  press(await vi.waitFor(() => {
    const item = menuItems(of).find((node) => node.title === email(id));
    if (!item) throw new Error("menu closed");
    return item;
  }));
}
function expectConsistent(f: Awaited<ReturnType<typeof mount>>, of: Of) {
  const now = shown(of);
  expect(now.mains).toEqual([f.main[of]]);
  for (const page of group(of).querySelectorAll<HTMLElement>("[data-account-page]")) expect(accountIn(page)).toBe(page.dataset.accountPage);
  expect(now.trigger).toBe(f.phone || of === "claude" ? `Choose account: ${email(now.viewed!)}` : null);
  expect([...group(of).querySelectorAll<HTMLButtonElement>("button")].filter((node) => node.disabled && node.textContent === "Set as Main")).toEqual([]);
  expect(group(of).querySelector('[role="alert"]')).toBeNull();
}

describe.each([1280, 390])("rapid account switching in Usage at %ipx", (width) => {
  it("ends on the last accepted Set as Main after 50 fast clicks with delayed, reordered replies", async () => {
    const f = await mount(width, width);
    for (let clicks = 0; clicks < 50;) {
      const of: Of = f.random(3) ? "claude" : "codex";
      const button = setAsMain(of);
      const arrows = [...live(of).querySelectorAll<HTMLButtonElement>('[aria-label="Next Account"], [aria-label="Previous Account"]')].filter((node) => !node.disabled);
      if (button && (f.random(3) || !arrows.length)) {
        press(button);
        clicks += 1;
      } else if (arrows.length) press(arrows[f.random(arrows.length)]!);
      await sleep(f.random(30));
    }
    await f.settled();
    expect(f.posts.length).toBeGreaterThan(10);
    for (const of of ["claude", "codex"] as const) {
      expect(f.main[of]).toBe(f.posts.findLast((id) => engineOf(id) === of) ?? of);
      expectConsistent(f, of);
    }
  });

  it("ends on the last of 50 fast account list picks without changing Main", async () => {
    const f = await mount(width, width + 1);
    const choices = (of: Of) => PEOPLE.filter(([id, each]) => each === of && (f.phone || id !== of)).map(([id]) => id);
    const last: Partial<Record<Of, string>> = {};
    for (let picks = 0; picks < 50; picks += 1) {
      const of: Of = f.phone && !f.random(3) ? "codex" : "claude";
      const id = choices(of)[f.random(choices(of).length)]!;
      await pick(of, id);
      last[of] = id;
      await sleep(f.random(30));
    }
    await f.settled();
    expect(f.posts).toEqual([]);
    for (const of of Object.keys(last) as Of[]) {
      expect(shown(of).viewed).toBe(last[of]);
      expectConsistent(f, of);
    }
  });

  it("ends on the last of 50 keyboard list picks and returns focus to the account name", async () => {
    const f = await mount(width, width + 2);
    let last = f.phone ? "claude" : acct(1);
    for (let picks = 0; picks < 50;) {
      trigger("claude")!.focus();
      key("Enter");
      await vi.waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("menuitemradio"));
      expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");
      for (let moves = f.random(5); moves > 0; moves -= 1) key(["ArrowDown", "ArrowUp", "Home", "End"][f.random(4)]!);
      if (f.random(6)) {
        last = PEOPLE.find(([id]) => email(id) === (document.activeElement as HTMLElement).title)![0];
        key("Enter");
        picks += 1;
      } else key("Escape");
      await vi.waitFor(() => expect(document.activeElement).toBe(trigger("claude")));
      await sleep(f.random(30));
    }
    await f.settled();
    expect(f.posts).toEqual([]);
    expect(shown("claude").viewed).toBe(last);
    expectConsistent(f, "claude");
  });

  it("keeps the account picked from the list while Set as Main is still saving", async () => {
    const f = await mount(width);
    if (f.phone) press(live("claude").querySelector<HTMLButtonElement>('[aria-label="Next Account"]')!);
    await vi.waitFor(() => expect(shown("claude").viewed).toBe(acct(1)));
    f.manual();
    press(setAsMain("claude")!);
    const saved = await f.take("POST");
    await pick("claude", acct(3));
    await vi.waitFor(() => expect(shown("claude").viewed).toBe(acct(3)));
    f.push();
    saved();
    (await f.take("GET"))();
    await f.settled();
    expect(shown("claude")).toEqual({ mains: [acct(1)], viewed: acct(3), trigger: `Choose account: ${email(acct(3))}` });
  });
});

it("keeps a Main switched in another window when an older reload reply lands after its live frame", async () => {
  const f = await mount(1280);
  f.manual();
  press(setAsMain("claude")!);
  const saved = await f.take("POST");
  f.push();
  saved();
  const reload = await f.take("GET");
  f.elsewhere(acct(4));
  await vi.waitFor(() => expect(shown("codex").mains).toEqual([acct(4)]));
  reload();
  await f.settled();
  expect({ claude: shown("claude").mains, codex: shown("codex").mains }).toEqual({ claude: [acct(1)], codex: [acct(4)] });
});
