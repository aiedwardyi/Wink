import { deflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

import { WEB_READ_OWN_TOOL, WEB_READ_SEARCH_ONLY, WEB_READ_STOP } from "../shared/web-read.ts";
import { createWebReader, PAUSE_429_MS, SITE_BUDGET, siteKey, youtubeId } from "./web-read.ts";
import { guardedLookup, privateAddress, refusedTarget, type Hop, type Transport } from "./web-read-net.ts";
import { TEXT_CAP } from "./web-read-text.ts";

type Fixture = { status?: number; type?: string; html?: string; body?: string | Buffer; location?: string; error?: Error; truncated?: boolean };
type Routes = Record<string, Fixture>;

const seen: Array<{ url: string; headers: Record<string, string> }> = [];
const unexpected: string[] = [];

function fake(routes: Routes) {
  const requests: string[] = [];
  const transport: Transport = async (url, headers) => {
    requests.push(url.href);
    seen.push({ url: url.href, headers });
    const fixture = routes[url.href];
    if (!fixture) {
      unexpected.push(url.href);
      throw Object.assign(new Error("no fixture"), { code: "ENOTFOUND" });
    }
    if (fixture.error) throw fixture.error;
    const hop: Hop = {
      status: fixture.status ?? 200,
      headers: { "content-type": fixture.type ?? "text/html; charset=utf-8", ...(fixture.location ? { location: fixture.location } : {}) },
      body: Buffer.isBuffer(fixture.body) ? fixture.body : Buffer.from(fixture.html ?? fixture.body ?? ""),
      truncated: fixture.truncated ?? false,
    };
    return hop;
  };
  return { transport, requests };
}

const page = (title: string, body: string, head = "") => `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
const paras = (n: number, word: string) => Array.from({ length: n }, (_, i) => `<p>${word} paragraph ${i} explains the topic in plain words so a reader can follow along.</p>`).join("");
const chrome = "<nav><a href='/'>Home</a><a href='/about'>About</a></nav><header>Site header</header>";
const pdf = (text: string) => {
  const stream = deflateSync(Buffer.from(`BT /F1 12 Tf 72 712 Td (${text}) Tj ET`, "latin1"));
  return Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), stream, Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")]);
};
const player = (tracks: unknown[]) => `<html><body><script>var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: { title: "How tides work", author: "Ocean Lab", shortDescription: "A short explainer about tides and the moon." }, captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } })};var meta = 1;</script></body></html>`;
const YT_WATCH = "https://www.youtube.com/watch?v=abc123XYZ00&hl=en";
const YT_CAPTION = "https://www.youtube.com/api/timedtext?v=abc123XYZ00&lang=en&fmt=json3";
const json3 = JSON.stringify({ events: [{ segs: [{ utf8: "The moon pulls on the ocean" }] }, { segs: [{ utf8: " and that makes the tide rise twice a day." }] }] });

type Case = { name: string; url: string; routes: Routes; status: "ok" | "blocked"; route: string; tried?: RegExp; text?: RegExp; next?: boolean; requests?: number };

const CASES: Case[] = [
  { name: "news article", url: "https://news.example.com/2026/11/story", routes: { "https://news.example.com/2026/11/story": { html: page("Council votes", `${chrome}<article><h1>Council votes</h1>${paras(8, "News")}</article><footer>(c) paper</footer>`) } }, status: "ok", route: "fetch", text: /News paragraph 7/ },
  { name: "docs page", url: "https://docs.example.dev/guide/start", routes: { "https://docs.example.dev/guide/start": { html: page("Getting started", `${chrome}<main><h2>Install</h2>${paras(6, "Docs")}<pre>npm i thing</pre></main>`) } }, status: "ok", route: "fetch", text: /## Install/ },
  { name: "GitHub repo", url: "https://github.com/acme/widget", routes: { "https://github.com/acme/widget": { html: page("acme/widget", `${chrome}<article class="markdown-body"><h1>widget</h1>${paras(5, "Readme")}</article>`) } }, status: "ok", route: "fetch", text: /Readme paragraph 4/ },
  { name: "blog without article tag", url: "https://someblog.net/post/1", routes: { "https://someblog.net/post/1": { html: page("A post", `<div class="post">${paras(5, "Blog")}</div>`) } }, status: "ok", route: "fetch", text: /Blog paragraph 0/ },
  { name: "Wikipedia", url: "https://en.wikipedia.org/wiki/Tide", routes: { "https://en.wikipedia.org/wiki/Tide": { html: page("Tide - Wikipedia", `${chrome}<main id="content"><h1>Tide</h1>${paras(10, "Wiki")}<table><tr><td>a</td><td>b</td></tr></table></main>`) } }, status: "ok", route: "fetch", text: /Wiki paragraph 9/ },
  { name: "PDF link", url: "https://example.org/report.pdf", routes: { "https://example.org/report.pdf": { type: "application/pdf", body: pdf("Quarterly report: revenue grew twelve percent across all regions this year, led by exports.") } }, status: "ok", route: "fetch:pdf", text: /revenue grew twelve percent/ },
  { name: "scanned PDF", url: "https://example.org/scan.pdf", routes: { "https://example.org/scan.pdf": { type: "application/pdf", body: Buffer.from("%PDF-1.4\n1 0 obj\n<< /Subtype /Image /Filter /DCTDecode >>\nstream\n\u00ff\u00d8\u00ff\nendstream\n%%EOF") } }, status: "blocked", route: "fetch:pdf", tried: /no extractable text/, next: true },
  { name: "plain text", url: "https://example.org/notes.txt", routes: { "https://example.org/notes.txt": { type: "text/plain", body: "Line one of the notes.\nLine two." } }, status: "ok", route: "fetch", text: /Line two/ },
  { name: "JSON API", url: "https://api.example.org/v1/item/7", routes: { "https://api.example.org/v1/item/7": { type: "application/json", body: '{"id":7,"name":"seven"}' } }, status: "ok", route: "fetch", text: /"seven"/ },
  { name: "RSS feed", url: "https://example.org/feed.xml", routes: { "https://example.org/feed.xml": { type: "application/rss+xml", body: "<rss><channel><title>Feed</title></channel></rss>" } }, status: "ok", route: "fetch", text: /<title>Feed/ },
  { name: "SPA shell", url: "https://app.example.io/dashboard", routes: { "https://app.example.io/dashboard": { html: page("App", '<div id="root"></div><script src="/main.js"></script>') } }, status: "blocked", route: "fetch", tried: /empty JavaScript page/, next: true },
  { name: "X post (og meta)", url: "https://x.com/jack/status/20", routes: { "https://x.com/jack/status/20": { html: page("X", '<div id="react-root"></div>', '<meta property="og:description" content="just setting up my twttr and saying hello to everyone here">') } }, status: "ok", route: "fetch:meta", text: /just setting up my twttr[\s\S]*JavaScript/ },
  { name: "Cloudflare challenge", url: "https://shop.example.com/item", routes: { "https://shop.example.com/item": { status: 403, html: "<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>" } }, status: "blocked", route: "fetch", tried: /Cloudflare bot check \(Just a moment\) \(HTTP 403\)/, next: true },
  { name: "Product Hunt (Cloudflare)", url: "https://www.producthunt.com/products/wink", routes: { "https://www.producthunt.com/products/wink": { status: 403, html: '<html><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>' } }, status: "blocked", route: "fetch", tried: /Cloudflare bot check/, next: true },
  { name: "Cloudflare challenge served as 200", url: "https://cf200.example.com/", routes: { "https://cf200.example.com/": { html: `<html><head><title>Just a moment...</title></head><body>${paras(3, "x")}</body></html>` } }, status: "blocked", route: "fetch", tried: /Cloudflare/, next: true },
  { name: "G2 (DataDome)", url: "https://www.g2.com/products/wink/reviews", routes: { "https://www.g2.com/products/wink/reviews": { status: 403, html: '<html><body><script src="https://ct.captcha-delivery.com/c.js"></script><div id="cmsg">Please enable JS</div></body></html>' } }, status: "blocked", route: "fetch", tried: /DataDome/, next: true },
  { name: "Reddit network security", url: "https://www.reddit.com/r/selfhosted/comments/abc/post/", routes: { "https://www.reddit.com/r/selfhosted/comments/abc/post/": { status: 403, html: "<html><body>You've been blocked by network security.</body></html>" } }, status: "blocked", route: "fetch", tried: /network security/, next: true },
  { name: "Akamai denied", url: "https://store.example.com/p/1", routes: { "https://store.example.com/p/1": { status: 403, html: "<html><head><title>Access Denied</title></head><body>Access Denied. You don't have permission. Reference #18.2f3c1702.1732252800.9a1b</body></html>" } }, status: "blocked", route: "fetch", tried: /Akamai/, next: true },
  { name: "CAPTCHA page", url: "https://forum.example.com/t/1", routes: { "https://forum.example.com/t/1": { html: '<html><body><h1>Verify you are human</h1><div class="g-recaptcha"></div></body></html>' } }, status: "blocked", route: "fetch", tried: /CAPTCHA/, next: true },
  { name: "login wall redirect", url: "https://members.example.com/post/9", routes: { "https://members.example.com/post/9": { status: 302, location: "/login?next=/post/9" }, "https://members.example.com/login?next=/post/9": { html: page("Sign in", "<form><input name=user></form>") } }, status: "blocked", route: "fetch", tried: /login wall/, next: true },
  { name: "redirect then article", url: "http://example.net/old", routes: { "http://example.net/old": { status: 301, location: "https://example.net/new" }, "https://example.net/new": { html: page("New", `<article>${paras(5, "Moved")}</article>`) } }, status: "ok", route: "fetch", text: /Moved paragraph/ },
  { name: "404", url: "https://example.com/missing", routes: { "https://example.com/missing": { status: 404, html: page("Not found", "<h1>404</h1>") } }, status: "blocked", route: "fetch", tried: /HTTP 404, page not found/, next: false },
  { name: "429", url: "https://busy.example.com/a", routes: { "https://busy.example.com/a": { status: 429, html: "slow down" } }, status: "blocked", route: "fetch", tried: /HTTP 429, example.com paused for 10 min, no retry/, next: true, requests: 1 },
  { name: "500", url: "https://flaky.example.com/a", routes: { "https://flaky.example.com/a": { status: 503, html: "<html><body>Service unavailable</body></html>" } }, status: "blocked", route: "fetch", tried: /HTTP 503/, next: true },
  { name: "redirect loop", url: "https://loop.example.com/a", routes: { "https://loop.example.com/a": { status: 302, location: "/b" }, "https://loop.example.com/b": { status: 302, location: "/a" } }, status: "blocked", route: "fetch", tried: /redirect loop/, next: true, requests: 2 },
  { name: "redirect into a private address", url: "https://evil.example.com/r", routes: { "https://evil.example.com/r": { status: 302, location: "http://169.254.169.254/latest/meta-data/" } }, status: "blocked", route: "fetch", tried: /private address, not followed/, next: false, requests: 1 },
  { name: "name resolving to a private address", url: "https://rebind.example.com/", routes: { "https://rebind.example.com/": { error: Object.assign(new Error("rebind.example.com resolves to a private address"), { code: "EPRIVATE" }) } }, status: "blocked", route: "fetch", tried: /private address, not read/, next: false },
  { name: "timeout", url: "https://slow.example.com/", routes: { "https://slow.example.com/": { error: Object.assign(new Error("timed out"), { name: "TimeoutError" }) } }, status: "blocked", route: "fetch", tried: /no answer in 10 s/, next: true },
  { name: "huge page", url: "https://big.example.com/", routes: { "https://big.example.com/": { truncated: true, html: page("Big", `<article>${paras(400, "Huge")}</article>`) } }, status: "ok", route: "fetch", tried: /over 2 MB/, text: /\[truncated: showing 8,000 of/ },
  { name: "image (non-text)", url: "https://cdn.example.com/cat.png", routes: { "https://cdn.example.com/cat.png": { type: "image/png", body: Buffer.alloc(4096, 1) } }, status: "blocked", route: "fetch", tried: /not a text page \(image\/png, 4 KB\)/, next: false },
  { name: "YouTube with captions", url: "https://youtu.be/abc123XYZ00", routes: { [YT_WATCH]: { html: player([{ baseUrl: "/api/timedtext?v=abc123XYZ00&lang=en", languageCode: "en" }]) }, [YT_CAPTION]: { type: "application/json", body: json3 } }, status: "ok", route: "youtube-captions", text: /Transcript \(en\):\nThe moon pulls on the ocean and that makes the tide rise/, requests: 2 },
  { name: "YouTube caption needs a token", url: "https://www.youtube.com/watch?v=abc123XYZ00", routes: { [YT_WATCH]: { html: player([{ baseUrl: "https://www.youtube.com/api/timedtext?v=abc123XYZ00&lang=en", languageCode: "en" }]) }, [YT_CAPTION]: { type: "text/html", body: "" } }, status: "blocked", route: "youtube", tried: /YouTube sent no caption text/, text: /Partial: no transcript[\s\S]*tides and the moon/, next: true, requests: 2 },
  { name: "YouTube 429", url: "https://m.youtube.com/shorts/abc123XYZ00", routes: { [YT_WATCH]: { status: 429, html: "" } }, status: "blocked", route: "youtube", tried: /HTTP 429, youtube.com paused for 10 min, no retry/, next: true, requests: 1 },
  { name: "LinkedIn company page", url: "https://www.linkedin.com/company/microsoft/", routes: {}, status: "blocked", route: "search-only", tried: /never fetches linkedin.com/, next: true, requests: 0 },
  { name: "redirect into LinkedIn", url: "https://lnk.example.com/go", routes: { "https://lnk.example.com/go": { status: 302, location: "https://www.linkedin.com/in/someone" } }, status: "blocked", route: "fetch", tried: /linkedin.com, which Wink never fetches/, next: true, requests: 1 },
];

describe("web_read ladder over URL classes", () => {
  it("covers at least 25 classes", () => expect(CASES.length).toBeGreaterThanOrEqual(25));

  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const { transport, requests } = fake(c.routes);
    const reader = createWebReader({ transport });
    const result = await reader.read(c.url);
    expect(result.status).toBe(c.status);
    expect(result.route).toBe(c.route);
    expect(result.tried.length).toBeGreaterThan(0);
    if (c.tried) expect(result.tried.join("\n")).toMatch(c.tried);
    if (c.text) expect(result.text).toMatch(c.text);
    if (c.next !== undefined) expect(Boolean(result.next)).toBe(c.next);
    if (c.requests !== undefined) expect(requests).toHaveLength(c.requests);
    expect(result.text.length).toBeLessThanOrEqual(TEXT_CAP + 80);
  });

  afterAll(() => {
    expect(unexpected).toEqual([]);
    const hosts = new Set(seen.map((request) => new URL(request.url).hostname));
    const allowed = new Set(CASES.flatMap((c) => [new URL(c.url).hostname, ...Object.keys(c.routes).map((u) => new URL(u).hostname)]));
    for (const host of hosts) expect(allowed.has(host)).toBe(true);
    for (const host of hosts) expect(host).not.toMatch(/jina\.ai|fxtwitter|vxtwitter|fixupx|nitter|twstalker|youtubetranscript|downsub|savesubs|tactiq|notegpt|kome\.ai|linkedin\.com|lnkd\.in/);
    for (const request of seen) {
      expect(Object.keys(request.headers).map((key) => key.toLowerCase())).not.toContain("cookie");
      expect(request.headers["user-agent"]).toMatch(/Chrome\//);
    }
  });
});

describe("web_read steps 3-6", () => {
  const blocked = { "https://www.reddit.com/r/a/comments/1/": { status: 403, html: "blocked by network security" } };
  const bots = [
    { botId: "me", name: "Me", engine: "grokAgent", busy: false },
    { botId: "c1", name: "Coder", engine: "codex", busy: false },
    { botId: "g-busy", name: "GrokBusy", engine: "grokAgent", busy: true },
    { botId: "g1", name: "Groky", engine: "grokAgent", busy: false },
    { botId: "cl", name: "Claudey", engine: "claudeAgent", busy: false },
  ];

  it("tells the bot to try its own web tool first, then borrows a free Grok bot before Codex, never itself", async () => {
    const { transport, requests } = fake(blocked);
    const reader = createWebReader({ transport, readers: () => bots });
    const first = await reader.read("https://www.reddit.com/r/a/comments/1/", { callerBotId: "me" });
    expect(first).toMatchObject({ status: "blocked", next: WEB_READ_OWN_TOOL });
    expect(first.reader).toBeUndefined();
    expect(first.tried.at(-1)).toBe("step 3 your own web tool: not tried yet");
    const second = await reader.read("https://www.reddit.com/r/a/comments/1/", { callerBotId: "me", ownToolFailed: true });
    expect(second.next).toBeUndefined();
    expect(second.reader).toEqual({ botId: "g1", name: "Groky", engine: "grokAgent" });
    expect(second.tried[0]).toMatch(/^step 0 cache/);
    expect(requests).toHaveLength(1);
  });

  it("stops honestly when no Codex or Grok bot is free", async () => {
    const { transport } = fake(blocked);
    const reader = createWebReader({ transport, readers: () => [bots[4]!] });
    const result = await reader.read("https://www.reddit.com/r/a/comments/1/", { ownToolFailed: true });
    expect(result).toMatchObject({ status: "blocked", route: "stop", text: WEB_READ_STOP });
    expect(result.next).toBeUndefined();
    expect(result.tried.join("\n")).toMatch(/network security[\s\S]*step 3 your own web tool: failed[\s\S]*step 4 cross-engine reader: no free Codex or Grok bot/);
    expect(result.text).toMatch(/paste/);
  });

  it("keeps LinkedIn to search results at every step and never requests it", async () => {
    const { transport, requests } = fake({});
    const reader = createWebReader({ transport, readers: () => bots });
    const first = await reader.read("linkedin.com/in/someone", { callerBotId: "me" });
    expect(first).toMatchObject({ status: "blocked", next: WEB_READ_SEARCH_ONLY, searchOnly: true });
    const second = await reader.read("https://www.linkedin.com/in/someone", { callerBotId: "me", ownToolFailed: true });
    expect(second).toMatchObject({ searchOnly: true, reader: { botId: "g1" } });
    reader.remember("https://www.linkedin.com/in/someone", "reader:grokAgent", "page text");
    expect((await reader.read("https://www.linkedin.com/in/someone")).status).toBe("blocked");
    expect(requests).toEqual([]);
  });

  it("serves a step-4 answer from the cache for 15 minutes", async () => {
    let now = 1_000_000;
    const { transport, requests } = fake({});
    const reader = createWebReader({ transport, now: () => now });
    reader.remember("https://www.reddit.com/r/b/", "reader:codex", "Thread text from the reader.");
    expect(await reader.read("https://www.reddit.com/r/b/")).toMatchObject({ status: "ok", route: "reader:codex", text: "Thread text from the reader." });
    now += 16 * 60_000;
    await reader.read("https://www.reddit.com/r/b/");
    expect(requests).toHaveLength(1);
  });
});

describe("web_read politeness", () => {
  it("caches a read for 15 minutes and shares one request between parallel reads", async () => {
    let now = 0;
    const url = "https://example.com/a";
    const { transport, requests } = fake({ [url]: { html: page("A", `<article>${paras(5, "Cached")}</article>`) } });
    const reader = createWebReader({ transport, now: () => now });
    const [a, b] = await Promise.all([reader.read(url), reader.read(url)]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    expect(requests).toHaveLength(1);
    now += 14 * 60_000;
    expect((await reader.read(url + "#frag")).tried[0]).toMatch(/^step 0 cache: read 14 min ago/);
    expect(requests).toHaveLength(1);
    now += 2 * 60_000;
    await reader.read(url);
    expect(requests).toHaveLength(2);
  });

  it(`holds each site to ${SITE_BUDGET} requests a minute without retrying`, async () => {
    let now = 0;
    const routes: Routes = {};
    for (const n of [1, 2, 3, 4]) routes[`https://blog${n === 4 ? "" : n}.example.com/p${n}`] = { html: page("P", `<article>${paras(5, "P")}</article>`) };
    const { transport, requests } = fake(routes);
    const reader = createWebReader({ transport, now: () => now });
    for (const url of Object.keys(routes).slice(0, 3)) expect((await reader.read(url)).status).toBe("ok");
    const fourth = await reader.read("https://blog.example.com/p4");
    expect(fourth.status).toBe("blocked");
    expect(fourth.tried[0]).toMatch(/polite limit reached \(3 requests a minute to example.com\)/);
    expect(requests).toHaveLength(3);
    now += 61_000;
    expect((await reader.read("https://blog.example.com/p4")).status).toBe("ok");
    expect(requests).toHaveLength(4);
  });

  it("skips the reader on a turn another person started", async () => {
    const { transport } = fake({ "https://www.g2.com/products/x/reviews": { status: 403, html: "<title>Just a moment...</title>" } });
    const reader = createWebReader({ transport, now: () => 0, readers: () => [{ botId: "g", name: "Grok", engine: "grokAgent", busy: false }] });
    const out = await reader.read("https://www.g2.com/products/x/reviews", { ownToolFailed: true, callerBotId: "me", noReader: true });
    expect(out).toMatchObject({ status: "blocked", route: "stop" });
    expect(out.reader).toBeUndefined();
    expect(out.tried.at(-1)).toMatch(/another person started/);
  });

  it("counts a redirect chain inside one site as one request of its budget", async () => {
    const routes: Routes = {
      "http://example.com/a": { status: 301, location: "https://example.com/a" },
      "https://example.com/a": { status: 301, location: "https://www.example.com/a" },
      "https://www.example.com/a": { html: page("A", `<article>${paras(5, "A")}</article>`) },
      "https://example.com/b": { html: page("B", `<article>${paras(5, "B")}</article>`) },
      "https://example.com/c": { html: page("C", `<article>${paras(5, "C")}</article>`) },
    };
    const { transport, requests } = fake(routes);
    const reader = createWebReader({ transport, now: () => 0 });
    for (const url of ["http://example.com/a", "https://example.com/b", "https://example.com/c"]) expect((await reader.read(url)).status).toBe("ok");
    expect(requests).toHaveLength(5);
    expect((await reader.read("https://example.com/d")).tried[0]).toMatch(/polite limit/);
  });

  it("pauses a site for 10 minutes after a 429, with no retry", async () => {
    let now = 0;
    const { transport, requests } = fake({
      "https://rate.example.com/a": { status: 429, html: "" },
      "https://rate.example.com/b": { html: page("B", `<article>${paras(5, "B")}</article>`) },
    });
    const reader = createWebReader({ transport, now: () => now });
    await reader.read("https://rate.example.com/a");
    const during = await reader.read("https://rate.example.com/b");
    expect(during.tried[0]).toMatch(/answered 429 \(too many requests\), so Wink leaves it alone for 10 more min/);
    expect(requests).toEqual(["https://rate.example.com/a"]);
    now += PAUSE_429_MS + 1;
    expect((await reader.read("https://rate.example.com/b")).status).toBe("ok");
    expect(requests).toEqual(["https://rate.example.com/a", "https://rate.example.com/b"]);
  });
});

describe("web_read SSRF guard", () => {
  it.each([
    "http://localhost:8799/api/internal/agents",
    "http://app.localhost/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f.0.0.1/",
    "http://0.0.0.0/",
    "http://10.0.0.5/",
    "http://172.16.4.1/",
    "http://192.168.1.1/admin",
    "http://100.100.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:a00:1]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://router.local/",
    "http://intranet/",
    "http://corp.internal/",
    "file:///C:/Windows/win.ini",
    "ftp://example.com/file",
    "javascript:alert(1)",
    "https://user:secret@example.com/",
  ])("refuses %s without a request", async (url) => {
    const { transport, requests } = fake({});
    const result = await createWebReader({ transport }).read(url);
    expect(result.status).toBe("blocked");
    expect(result.route).toBe("refused");
    expect(result.next).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it("allows public addresses", () => {
    for (const url of ["https://example.com/", "http://93.184.216.34/", "https://[2606:4700::6810:84e5]/"]) expect(refusedTarget(new URL(url))).toBeNull();
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700::6810:84e5"]) expect(privateAddress(address)).toBe(false);
  });

  it("fails the connection when DNS points a public name inward", async () => {
    const lookup = (address: string) =>
      new Promise<{ error: (Error & { code?: string }) | null; address?: unknown }>((resolve) =>
        guardedLookup((_host, _options, callback) => callback(null, [{ address, family: address.includes(":") ? 6 : 4 }]))("evil.example.com", {}, (error: Error | null, result: unknown) => resolve({ error, address: result })),
      );
    expect((await lookup("10.1.2.3")).error?.code).toBe("EPRIVATE");
    expect((await lookup("::1")).error?.code).toBe("EPRIVATE");
    expect((await lookup("93.184.216.34")).error).toBeNull();
  });
});

describe("web_read helpers", () => {
  it.each([
    ["https://www.youtube.com/watch?v=abc123XYZ00", "abc123XYZ00"],
    ["https://youtu.be/abc123XYZ00?t=4", "abc123XYZ00"],
    ["https://m.youtube.com/shorts/abc123XYZ00", "abc123XYZ00"],
    ["https://www.youtube.com/live/abc123XYZ00", "abc123XYZ00"],
    ["https://www.youtube.com/@channel", null],
    ["https://example.com/watch?v=x", null],
  ])("youtubeId(%s)", (url, id) => expect(youtubeId(new URL(url))).toBe(id));

  it.each([["www.bbc.co.uk", "bbc.co.uk"], ["old.reddit.com", "reddit.com"], ["example.com", "example.com"], ["a.b.example.org", "example.org"]])("siteKey(%s)", (host, key) => expect(siteKey(host)).toBe(key));
});
