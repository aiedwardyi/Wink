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
  const shown = [];
  const opened = [];
  const self = {
    location: { hostname, origin: `https://${hostname}` },
    skipWaiting: () => {},
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
    registration: { showNotification: async (title, options) => shown.push({ title, options }) },
    clients: { matchAll: async () => windows, openWindow: async (url) => opened.push(url) },
  };
  const caches = {
    open: async () => ({
      add: async (request) => cache.set(request.url, `cached ${request.url}`),
      match: async (url) => cache.get(url),
    }),
    match: async (url) => cache.get(url),
  };
  class Request {
    constructor(url) {
      this.url = url;
    }
  }
  const now = 1_800_000_000_000;
  runInNewContext(SOURCE, { self, caches, fetch: network, Request, Response, URL, setTimeout, Date: { now: () => now } });
  return { listeners, cache, shown, opened, now };
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

async function click(listeners, url) {
  let done;
  listeners.notificationclick({ notification: { data: { url }, close: () => {} }, waitUntil: (promise) => (done = promise) });
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
      });
    }
    expect(location.href).toBe(`https://${RELAY}/?bot=b1&thread=t-new#top`);
    clicks.find(([type]) => type === "click")[1]();
    expect(location.reload).toHaveBeenCalledOnce();
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
    });
    expect(element("pick").href).toBe("https://wink.test/?pick=1");
    expect(element("pick").textContent).toBe(text);
    expect(element("pick").hidden).toBe(false);
  });
});
