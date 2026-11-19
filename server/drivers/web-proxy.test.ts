import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { guardedLookup, htmlToText, OPEN, PUBLIC_ONLY, readUrl, turnPolicy, TOOLS } from "./web-proxy.ts";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "web-proxy.ts");
const ANY = OPEN;

let site: Server;
let base = "";
// 1.5 KB of brotli that decodes to 1 GB of zeros.
const bomb = Buffer.from("y///P/gnAOKxQCD3/o///3/wTwDEYRGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/L/2QN/BMAcVgAoBusAQ==", "base64");
const page = (body: string) => `<!doctype html><html><head><title>Example &amp; Co</title><style>p{color:red}</style><script>var secret=1</script></head><body>${body}</body></html>`;

beforeAll(async () => {
  site = createServer((req, res) => {
    if (req.url === "/page") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("<h1>Hello</h1><p>First &amp; second</p><p>Third</p>"));
    if (req.url === "/big") return res.writeHead(200, { "content-type": "text/plain" }).end("x".repeat(200_000));
    if (req.url === "/json") return res.writeHead(200, { "content-type": "application/json" }).end('{"a":1}');
    if (req.url === "/img") return res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([1, 2, 3]));
    if (req.url === "/gone") return res.writeHead(404, { "content-type": "text/plain" }).end("nope");
    if (req.url === "/bomb") return res.writeHead(200, { "content-type": "text/plain", "content-encoding": "br" }).end(bomb);
    if (req.url === "/drip") {
      res.writeHead(200, { "content-type": "text/plain" });
      const timer = setInterval(() => res.write("x"), 100);
      setTimeout(() => { clearInterval(timer); res.end(); }, 6000);
      res.on("close", () => clearInterval(timer));
      return;
    }
    if (req.url === "/cut") {
      const zipped = gzipSync("hello ".repeat(50_000));
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      return res.write(zipped.subarray(0, zipped.length >> 1), () => res.destroy());
    }
    if (req.url === "/long-title") return res.writeHead(200, { "content-type": "text/html" }).end(`<title>${"t".repeat(100_000)}</title><p>hi</p>`);
    if (req.url === "/latin") return res.writeHead(200, { "content-type": "text/plain; charset=iso-8859-1" }).end(Buffer.from("Fran\u00e7ais caf\u00e9", "latin1"));
    if (req.url === "/ok-location") return res.writeHead(200, { "content-type": "text/plain", location: "/page" }).end("own body");
    if (req.url === "/gone-location") return res.writeHead(404, { "content-type": "text/plain", location: "/page" }).end("nope");
    if (req.url === "/hop") return res.writeHead(302, { location: "/page" }).end();
    if (req.url === "/loop") return res.writeHead(302, { location: "/loop" }).end();
    if (req.url === "/to-file") return res.writeHead(302, { location: "file:///etc/passwd" }).end();
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});
afterAll(() => new Promise((resolve) => site.close(resolve)));

describe("read_url", () => {
  it("returns the title and body text with markup, style and script dropped", async () => {
    const out = await readUrl(`${base}/page`, ANY);
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain("Title: Example & Co");
    expect(out.text).toContain("First & second");
    expect(out.text).not.toMatch(/<|secret|color:red/);
  });

  it("cuts a huge page and says so", async () => {
    const out = await readUrl(`${base}/big`, ANY);
    expect(out.text.length).toBeLessThan(31_000);
    expect(out.text).toContain("[truncated");
  });

  it("follows a redirect and refuses a non-readable type, an error status and a redirect loop", async () => {
    expect((await readUrl(`${base}/hop`, ANY)).text).toContain("Hello");
    expect((await readUrl(`${base}/json`, ANY)).text).toContain('{"a":1}');
    expect(await readUrl(`${base}/img`, ANY)).toMatchObject({ isError: true });
    expect(await readUrl(`${base}/gone`, ANY)).toMatchObject({ isError: true });
    expect((await readUrl(`${base}/loop`, ANY)).text).toContain("Too many redirects");
  });

  it("refuses file, localhost and private-network addresses", async () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/",
      "http://localhost:3000/",
      "http://app.localhost/",
      "http://intranet/",
      "http://printer.local/",
      "http://127.0.0.1:8080/",
      "http://0.0.0.0/",
      "http://10.0.0.5/",
      "http://172.16.3.4/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:10.0.0.1]/",
      "http://2130706433/",
      "http://0x7f.1/",
    ]) {
      const out = await readUrl(url);
      expect(out, url).toMatchObject({ isError: true });
    }
  });

  it("refuses a public-looking redirect that lands on a private address", async () => {
    const out = await readUrl(`${base}/to-file`, ANY);
    expect(out).toMatchObject({ isError: true });
    expect(out.text).toContain("Only http and https");
    const hop = await readUrl(`${base}/hop`, { ...OPEN, blocks: (address) => address === "127.0.0.1" });
    expect(hop).toMatchObject({ isError: true });
  });

  it("refuses a name that resolves to a private address (DNS rebinding)", async () => {
    const lookup = guardedLookup(PUBLIC_ONLY, ((_host: string, _options: unknown, done: (e: null, a: { address: string; family: number }[]) => void) =>
      done(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }])) as never);
    const error = await new Promise<Error | null>((resolve) => lookup("evil.example.com", {}, (e) => resolve(e)));
    expect(error?.message).toContain("another person started");
    const good = await new Promise<unknown>((resolve) =>
      guardedLookup(PUBLIC_ONLY, ((_h: string, _o: unknown, done: (e: null, a: { address: string; family: number }[]) => void) =>
        done(null, [{ address: "93.184.216.34", family: 4 }])) as never)("example.com", {}, (_e, a) => resolve(a)),
    );
    expect(good).toBe("93.184.216.34");
  });

  it("follows Location only on a redirect status", async () => {
    expect((await readUrl(`${base}/ok-location`, ANY)).text).toContain("own body");
    expect(await readUrl(`${base}/gone-location`, ANY)).toMatchObject({ isError: true });
  });

  it("decodes the body with the charset the server declares", async () => {
    expect((await readUrl(`${base}/latin`, ANY)).text).toContain("Fran\u00e7ais caf\u00e9");
  });

  it("htmlToText keeps block breaks and decodes entities", () => {
    expect(htmlToText("<title>T&#33;</title><body><p>a&nbsp;b</p><p>c</p></body>")).toEqual({ title: "T!", text: "a b\n\nc" });
  });
});

describe("hostile pages", () => {
  it("stops decoding at the cap instead of inflating a compressed bomb", async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = process.memoryUsage().rss;
    const out = await readUrl(`${base}/bomb`, OPEN);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(out.text).toContain("[truncated");
    expect(process.memoryUsage().rss - before).toBeLessThan(100_000_000);
  }, 30_000);

  it("answers when a compressed response is cut off mid-body", async () => {
    expect(await readUrl(`${base}/cut`, OPEN)).toMatchObject({ isError: true });
  }, 5000);

  it("counts a huge title against the output limit", async () => {
    const out = await readUrl(`${base}/long-title`, OPEN);
    expect(out.text.length).toBeLessThan(31_000);
    expect(out.text).toContain("[truncated");
  });

  it("gives up on a server that drips bytes past the whole-call deadline", async () => {
    const started = Date.now();
    const out = await readUrl(`${base}/drip`, OPEN, 600);
    expect(out).toMatchObject({ isError: true });
    expect(out.text).toContain("took longer");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("converts 2 MB of unclosed markup in about a second", () => {
    for (const unit of ["<a ", "<script ", "<!--", "<title", "<p>x</p><i "]) {
      const html = unit.repeat(Math.ceil(2_000_000 / unit.length));
      const started = Date.now();
      htmlToText(html);
      expect(Date.now() - started, unit).toBeLessThan(1500);
    }
  });

  it("marks the page as untrusted and keeps public IPv4 reachable under the guard", async () => {
    expect((await readUrl(`${base}/page`, OPEN)).text).toContain("untrusted data");
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) expect(PUBLIC_ONLY.blocks(address), address).toBe(false);
    for (const address of ["::7f00:1", "::ffff:0:7f00:1", "64:ff9b:1::7f00:1", "2002:7f00:1::"]) expect(PUBLIC_ONLY.blocks(address), address).toBe(true);
  });
});

describe("who started the turn", () => {
  it("opens localhost and LAN names in the user's own chat, refuses them on another person's room turn", async () => {
    expect(turnPolicy({})).toBe(OPEN);
    expect(turnPolicy({ OMB_READ_ONLY_TURN: "1" })).toBe(PUBLIC_ONLY);
    for (const url of [`${base}/page`, "http://[::1]:1/", "http://printer.local/", "http://intranet/"]) {
      const own = await readUrl(url, turnPolicy({}));
      expect(own.text, url).not.toMatch(/another person started/);
    }
    expect((await readUrl(`${base}/page`, turnPolicy({}))).text).toContain("Title: Example & Co");
    const guest = await readUrl(`${base}/page`, turnPolicy({ OMB_READ_ONLY_TURN: "1" }));
    expect(guest).toMatchObject({ isError: true });
    expect(guest.text).toBe("Private and local addresses can't be opened on a turn another person started in a room. Public links work, or the host can ask in their own chat.");
  });

  it("a name that resolves private is refused with the same line on a guest turn only", async () => {
    const answer = ((_h: string, _o: unknown, done: (e: null, a: { address: string; family: number }[]) => void) => done(null, [{ address: "10.0.0.7", family: 4 }])) as never;
    const guest = await new Promise<Error | null>((resolve) => guardedLookup(PUBLIC_ONLY, answer)("lan.example.com", {}, (e) => resolve(e)));
    expect(guest?.message).toContain("another person started");
    const own = await new Promise<unknown>((resolve) => guardedLookup(OPEN, answer)("lan.example.com", {}, (_e, a) => resolve(a)));
    expect(own).toBe("10.0.0.7");
  });
});

describe("web-proxy stdio", () => {
  const ask = async (env: Record<string, string>, url: string) => {
    const child = spawn(process.execPath, [PROXY], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true, env: { ...process.env, OMB_READ_ONLY_TURN: "", ...env } });
    const reply = new Promise<any>((resolve) => child.stdout.once("data", (chunk) => resolve(JSON.parse(String(chunk)))));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_url", arguments: { url } } })}\n`);
    const message = await reply;
    child.kill();
    return message.result;
  };

  it("lists read_url as the only tool, marked read-only", async () => {
    const child = spawn(process.execPath, [PROXY], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    const reply = new Promise<any>((resolve) => child.stdout.once("data", (chunk) => resolve(JSON.parse(String(chunk)))));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const message = await reply;
    child.kill();
    expect(message.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["read_url"]);
    expect(TOOLS[0].annotations.readOnlyHint).toBe(true);
  });

  it("reads a localhost page in an own chat and refuses it on a read-only room turn", async () => {
    const own = await ask({}, `${base}/page`);
    expect(own.isError).toBe(false);
    expect(own.content[0].text).toContain("Title: Example & Co");
    const guest = await ask({ OMB_READ_ONLY_TURN: "1" }, `${base}/page`);
    expect(guest.isError).toBe(true);
    expect(guest.content[0].text).toContain("another person started");
  });
});
