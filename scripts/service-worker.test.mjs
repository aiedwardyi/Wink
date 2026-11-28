import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(ROOT, "public/sw.js"), "utf8");
const RELAY = "abcdefghijklmnop.wink.test";

/** Runs public/sw.js for one origin with a fake cache and network. */
function worker(hostname, network = () => Promise.reject(new TypeError("Failed to fetch")), windows = []) {
  const listeners = {};
  const cache = new Map();
  const calls = new Map();
  const shown = [];
  const opened = [];
  const self = {
    location: { hostname, origin: `https://${hostname}` },
    skipWaiting: () => {},
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
    registration: {
      showNotification: async (title, options) => {
        // As browsers do: a silent alert may not vibrate.
        if (options.silent && options.vibrate) throw new TypeError("silent notifications cannot vibrate");
        shown.push({ title, options });
      },
    },
    clients: { matchAll: async () => windows, openWindow: async (url) => opened.push(url) },
  };
  const caches = {
    open: async (name) => {
      const store = name === "wink-calls-v1" ? calls : cache;
      return {
        add: async (request) => store.set(request.url, `cached ${request.url}`),
        match: async (url) => store.get(url),
        put: async (url, response) => void store.set(url, response),
        keys: async () => [...store.keys()],
        delete: async (url) => store.delete(url),
      };
    },
    match: async (url) => cache.get(url),
  };
  class Request {
    constructor(url) {
      this.url = url;
    }
  }
  const clock = { now: 1_800_000_000_000 };
  runInNewContext(SOURCE, { self, caches, fetch: network, Request, Response, URL, setTimeout, Date: { now: () => clock.now } });
  return { listeners, cache, calls, shown, opened, now: clock.now, clock };
}

async function push(listeners, data) {
  let done;
  listeners.push({ data: { json: () => data }, waitUntil: (promise) => (done = promise) });
  await done;
}

async function install(listeners) {
  let done;
  listeners.install({ waitUntil: (promise) => (done = promise) });
  await done;
}

async function click(listeners, url, extra = {}) {
  let done;
  listeners.notificationclick({ notification: { data: { url, ...extra.data }, close: () => {} }, action: extra.action ?? "", waitUntil: (promise) => (done = promise) });
  await done;
}

function load(listeners, mode) {
  let answer = null;
  const waits = [];
  listeners.fetch({
    request: { mode, method: "GET", url: `https://${RELAY}/` },
    respondWith: (promise) => (answer = promise),
    waitUntil: (promise) => waits.push(promise),
  });
  return answer && Promise.all([answer, ...waits]).then(([page]) => page);
}

/** Runs public/offline.html's scripts online, with the relay's status and the PC's own answer faked. */
async function offlinePage({ status, pcAnswers, retriedAt = null }) {
  const page = readFileSync(join(ROOT, "public/offline.html"), "utf8");
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: "", hidden: false, addEventListener() {} });
    return elements.get(id);
  };
  const location = { hostname: RELAY, href: `https://${RELAY}/`, reload: vi.fn() };
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    if (url === "https://relay.wink.test/v1/status/abcdefghijklmnop") return { json: async () => status };
    if (pcAnswers) return { ok: true };
    throw new TypeError("Failed to fetch");
  };
  const saved = new Map(retriedAt === null ? [] : [["wink-offline-retry", String(retriedAt)]]);
  const sessionStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  for (const script of scripts) {
    runInNewContext(script, {
      URL,
      Date,
      location,
      history: {},
      fetch,
      sessionStorage,
      navigator: { onLine: true, language: "en" },
      localStorage: { getItem: () => null },
      document: { documentElement: {}, getElementById: element },
      window: { addEventListener() {} },
      setInterval() {},
      setTimeout() {},
    });
  }
  await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));
  await new Promise((resolve) => setImmediate(resolve));
  return { location, asked, saved, detail: element("detail"), panel: element("panel") };
}

describe("service worker", () => {
  it("registers the app shell and push handlers on tailnet and local origins", () => {
    for (const host of ["home.tail1234.ts.net", "abcdefghijklmnop.tail1234.ts.net", "127.0.0.1", "localhost"]) {
      expect(Object.keys(worker(host).listeners).sort(), host).toEqual(["activate", "fetch", "install", "notificationclick", "push"]);
    }
  });

  it("keeps an offline fallback on a relay origin without a reachable app shell", async () => {
    const { listeners, cache } = worker(RELAY);
    expect(Object.keys(listeners).sort()).toEqual(["activate", "fetch", "install", "notificationclick", "push"]);
    await install(listeners);
    expect([...cache.keys()]).toEqual(["/offline.html"]);
  });

  it("answers a failed page load with the offline page and leaves other requests alone", async () => {
    const { listeners } = worker(RELAY);
    await install(listeners);
    expect(await load(listeners, "navigate")).toBe("cached /offline.html");
    for (const mode of ["cors", "same-origin", "no-cors"]) expect(load(listeners, mode)).toBeNull();
  });

  it("shows the sending bot's icon and keeps the app icon as the badge", async () => {
    const { listeners, shown } = worker("home.tail1234.ts.net");
    await push(listeners, { title: "Scout has a question", body: "which branch?", tag: "openmausbot:b", url: "/", icon: "/notify-icons/pill-orange.png" });
    await push(listeners, { title: "Wink", body: "older server" });
    expect(shown.map(({ options }) => options.icon)).toEqual(["/notify-icons/pill-orange.png", "/app-icon-192.png?v=2"]);
    expect(shown.map(({ options }) => options.badge)).toEqual(["/app-icon-192.png?v=2", "/app-icon-192.png?v=2"]);
  });

  it("tags each alert with its chat and send time", async () => {
    const { listeners, shown } = worker("home.tail1234.ts.net");
    await push(listeners, { title: "Scout finished", body: "done", tag: "openmausbot:b1", url: "/?bot=b1&thread=t1", chat: "g1", at: 7 });
    expect(shown[0].options.data).toEqual({ url: "/?bot=b1&thread=t1", chat: "g1", at: 7 });
  });

  it("shows a bot call as a ringing alert that waits for a tap", async () => {
    const { listeners, shown } = worker("home.tail1234.ts.net");
    const call = { title: "📞 Scout is calling", body: "Sign in on Home.", tag: "wink-call:b1", url: "/?bot=b1&thread=t1&call=Sign+in+on+Home.", icon: "/i.png", chat: "b1", at: 7, call: "c1" };
    await push(listeners, call);
    expect(shown[0]).toEqual({
      title: "📞 Scout is calling",
      options: {
        body: "Sign in on Home.",
        tag: "wink-call:b1",
        renotify: true,
        requireInteraction: true,
        vibrate: [1000, 500, 1000, 500, 1000, 500, 1000],
        icon: "/i.png",
        badge: "/app-icon-192.png?v=2",
        actions: [{ action: "answer", title: "Answer" }, { action: "later", title: "Not now" }],
        data: { url: call.url, chat: "b1", at: 7, call: "c1" },
      },
    });
  });

  it("keeps a plain alert plain", async () => {
    const { listeners, shown } = worker("home.tail1234.ts.net");
    await push(listeners, { title: "Scout has a question", body: "which branch?", tag: "openmausbot:b1", url: "/?bot=b1&thread=t1", icon: "/i.png", chat: "b1", at: 7 });
    expect(shown[0].options).toEqual({
      body: "which branch?",
      tag: "openmausbot:b1",
      renotify: true,
      vibrate: [200, 100, 200],
      icon: "/i.png",
      badge: "/app-icon-192.png?v=2",
      data: { url: "/?bot=b1&thread=t1", chat: "b1", at: 7 },
    });
  });

  it("answers a call by opening its chat with the call param", async () => {
    const { listeners, opened, now } = worker("home.tail1234.ts.net");
    await click(listeners, "/?bot=b1&thread=t1&call=Sign+in", { action: "answer", data: { call: "c1" } });
    await click(listeners, "/?bot=b1&thread=t1&call=Sign+in", { data: { call: "c2" } });
    expect(opened).toEqual([
      `https://home.tail1234.ts.net/?bot=b1&thread=t1&call=Sign+in&t0=${now}`,
      `https://home.tail1234.ts.net/?bot=b1&thread=t1&call=Sign+in&t0=${now}`,
    ]);
  });

  it("puts a call off without opening anything, and its later rings stay quiet", async () => {
    const { listeners, opened, shown } = worker("home.tail1234.ts.net");
    await click(listeners, "/?bot=b1&thread=t1&call=Sign+in", { action: "later", data: { call: "c1" } });
    expect(opened).toEqual([]);
    await push(listeners, { title: "📞 Scout is calling", body: "Sign in", tag: "wink-call:b1", url: "/?bot=b1&thread=t1&call=Sign+in", call: "c1" });
    expect(shown[0].options).toMatchObject({ silent: true, renotify: false });
    expect(shown[0].options.vibrate).toBeUndefined();
    expect(shown[0].options.requireInteraction).toBeUndefined();
    expect(shown[0].options.actions).toBeUndefined();
  });

  it("forgets handled calls once their rings are long over", async () => {
    const { listeners, calls, clock } = worker("home.tail1234.ts.net");
    await click(listeners, "/?bot=b1&thread=t1&call=Sign+in", { action: "later", data: { call: "c1" } });
    clock.now += 11 * 60_000;
    await click(listeners, "/?bot=b1&thread=t1&call=Sign+in", { action: "later", data: { call: "c2" } });
    expect([...calls.keys()]).toEqual(["/call/c2"]);
  });

  it("adds the tap time to the url when it opens a window", async () => {
    const { listeners, opened, now } = worker("home.tail1234.ts.net");
    await click(listeners, "/?bot=b1&thread=t-new");
    await click(listeners, undefined);
    expect(opened).toEqual([
      `https://home.tail1234.ts.net/?bot=b1&thread=t-new&t0=${now}`,
      `https://home.tail1234.ts.net/?t0=${now}`,
    ]);
  });

  it("sends the tap time with the target to an open window", async () => {
    const posted = [];
    const page = { url: "https://home.tail1234.ts.net/", focus: async () => {}, postMessage: (message) => posted.push(message) };
    const { listeners, opened, now } = worker("home.tail1234.ts.net", undefined, [page]);
    await click(listeners, "/?bot=b1&thread=t-new");
    expect(opened).toEqual([]);
    expect(posted).toEqual([{ type: "orbit-open", url: "https://home.tail1234.ts.net/?bot=b1&thread=t-new", t0: now }]);
  });

  it("drops the tap time from the offline page address and keeps retry working", async () => {
    const page = readFileSync(join(ROOT, "public/offline.html"), "utf8");
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    const { listeners, opened, now } = worker(RELAY);
    await click(listeners, "/?bot=b1&thread=t-new#top");
    expect(opened).toEqual([`https://${RELAY}/?bot=b1&thread=t-new&t0=${now}#top`]);
    const location = { hostname: RELAY, href: opened[0], reload: vi.fn() };
    const history = { state: null, replaceState: (_state, _title, url) => (location.href = new URL(url, location.href).href) };
    const clicks = [];
    const element = () => ({ textContent: "", addEventListener: (type, listener) => clicks.push([type, listener]) });
    for (const script of scripts) {
      runInNewContext(script, {
        URL,
        location,
        history,
        navigator: { onLine: false, language: "en" },
        localStorage: { getItem: () => null },
        document: { documentElement: {}, getElementById: element },
        window: { addEventListener() {} },
        setInterval() {},
        setTimeout() {},
      });
    }
    expect(location.href).toBe(`https://${RELAY}/?bot=b1&thread=t-new#top`);
    clicks.find(([type]) => type === "click")[1]();
    expect(location.reload).toHaveBeenCalledOnce();
  });

  it("opens a chat tapped while the offline page shows", async () => {
    const page = readFileSync(join(ROOT, "public/offline.html"), "utf8");
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    const location = { hostname: RELAY, href: `https://${RELAY}/`, assign: vi.fn(), reload() {} };
    const serviceWorker = {};
    for (const script of scripts) {
      runInNewContext(script, {
        URL,
        location,
        history: {},
        navigator: { onLine: false, language: "en", serviceWorker },
        localStorage: { getItem: () => null },
        document: { documentElement: {}, getElementById: () => ({ textContent: "", addEventListener() {} }) },
        window: { addEventListener() {} },
        setInterval() {},
        setTimeout() {},
      });
    }
    const shown = { url: location.href, focus: async () => {}, postMessage: (data) => serviceWorker.onmessage({ data }) };
    const { listeners, now } = worker(RELAY, undefined, [shown]);
    await click(listeners, "/?bot=b1&thread=t-new");
    expect(location.assign).toHaveBeenCalledExactlyOnceWith(`https://${RELAY}/?bot=b1&thread=t-new&t0=${now}`);
  });

  it("loads the page again, unseen, when a load failed while the PC was up and the PC answers now", async () => {
    const shown = await offlinePage({ status: { online: true, since: 1 }, pcAnswers: true });
    expect(shown.asked).toEqual(["https://relay.wink.test/v1/status/abcdefghijklmnop", "/manifest.json"]);
    expect(shown.location.reload).toHaveBeenCalledOnce();
    expect(shown.panel.hidden).toBe(true);
    expect(shown.detail.textContent).toBe("");
  });

  it("keeps the certificate hint when the PC is up but does not answer this phone", async () => {
    const shown = await offlinePage({ status: { online: true, since: 1 }, pcAnswers: false });
    expect(shown.location.reload).not.toHaveBeenCalled();
    expect(shown.detail.textContent).toMatch(/^Your PC is online, but this page did not load/);
    expect(shown.panel.hidden).toBe(false);
  });

  it("loads again at most once a minute, so a load that keeps failing cannot loop", async () => {
    const shown = await offlinePage({ status: { online: true, since: 1 }, pcAnswers: true, retriedAt: Date.now() - 5_000 });
    expect(shown.location.reload).not.toHaveBeenCalled();
    expect(shown.detail.textContent).toMatch(/^Your PC is online, but this page did not load/);
    expect(shown.panel.hidden).toBe(false);
  });

  it("still says the PC is asleep, without loading again, when the relay says it is offline", async () => {
    const shown = await offlinePage({ status: { online: false }, pcAnswers: false });
    expect(shown.asked).toEqual(["https://relay.wink.test/v1/status/abcdefghijklmnop"]);
    expect(shown.location.reload).not.toHaveBeenCalled();
    expect(shown.detail.textContent).toBe("Your PC is asleep or Wink is closed.");
    expect(shown.panel.hidden).toBe(false);
  });

  it("lets a reachable PC answer the page load itself", async () => {
    const { listeners } = worker(RELAY, async () => new Response("live page"));
    await install(listeners);
    expect(await (await load(listeners, "navigate")).text()).toBe("live page");
  });

  it.each([["en", "Choose another PC"], ["ko", "다른 PC 선택"]])("links the %s offline page to PC discovery", (lang, text) => {
    const page = readFileSync(join(ROOT, "public/offline.html"), "utf8");
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    const elements = new Map();
    const element = (id) => {
      if (!elements.has(id)) elements.set(id, { textContent: "", hidden: true, addEventListener() {} });
      return elements.get(id);
    };
    for (const script of scripts) runInNewContext(script, {
      URL,
      location: { hostname: RELAY, href: `https://${RELAY}/` },
      history: {},
      navigator: { onLine: false, language: lang },
      localStorage: { getItem: () => lang },
      document: { documentElement: {}, getElementById: element },
      window: { addEventListener() {} },
      setInterval() {},
      setTimeout() {},
    });
    expect(element("pick").href).toBe("https://wink.test/?pick=1");
    expect(element("pick").textContent).toBe(text);
    expect(element("pick").hidden).toBe(false);
  });
});
