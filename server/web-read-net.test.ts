// Hostile-server cases ported from the earlier read_url reader (PR 1821), run against web_read's own transport.
import { createServer, type Server } from "node:http";
import { deflateSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWebReader } from "./web-read.ts";
import { guardedLookup, nodeTransport, privateAddress, refusedTarget, type Hop, type Transport } from "./web-read-net.ts";
import { bodyText, htmlToText, pdfToText, TEXT_CAP } from "./web-read-text.ts";

// 1.5 KB of brotli that decodes to 1 GB of zeros.
const bomb = Buffer.from("y///P/gnAOKxQCD3/o///3/wTwDEYRGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/j//8f/BMAcVgAoHv/x///P/gnAOKwAED3/o///3/wTwDEYQGA7v0f////4J8AiMMCAN37P/7//8E/ARCHBQC693/8//+DfwIgDgsAdO//+P//B/8EQBwWAOje//H//w/+CYA4LADQvf/L/2QN/BMAcVgAoBusAQ==", "base64");

let site: Server;
let base = "";
beforeAll(async () => {
  site = createServer((req, res) => {
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
    if (req.url === "/latin") return res.writeHead(200, { "content-type": "text/plain; charset=iso-8859-1" }).end(Buffer.from("Fran\u00e7ais caf\u00e9", "latin1"));
    if (req.url === "/cookie") return res.writeHead(200, { "content-type": "text/plain", "set-cookie": "sid=1" }).end("hi");
    if (req.url === "/hop") return res.writeHead(302, { location: "/latin" }).end("ignored");
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});
afterAll(() => new Promise((resolve) => site.close(resolve)));

const get = (path: string, ms = 10_000) => nodeTransport(new URL(base + path), { "user-agent": "test" }, AbortSignal.timeout(ms));

describe("web_read transport against hostile servers", () => {
  it("stops decoding at the cap instead of inflating a compressed bomb", async () => {
    const before = process.memoryUsage().rss;
    const hop = await get("/bomb");
    expect(hop.truncated).toBe(true);
    expect(hop.body.length).toBeLessThanOrEqual(2_000_000);
    expect(process.memoryUsage().rss - before).toBeLessThan(100_000_000);
  }, 30_000);

  it("answers when a compressed response is cut off mid-body", async () => {
    const settled = await get("/cut").then((hop) => (hop.truncated ? "partial" : "whole"), () => "error");
    expect(["partial", "error"]).toContain(settled);
  }, 5000);

  it("gives up on a server that drips bytes past the deadline", async () => {
    const started = Date.now();
    await get("/drip", 600).then((hop) => expect(hop.truncated).toBe(true), (error) => expect(String(error)).toMatch(/abort|timeout/i));
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("reports a redirect without following it, and never keeps a cookie", async () => {
    expect(await get("/hop")).toMatchObject({ status: 302, headers: { location: "/latin" } });
    const hop = await get("/cookie");
    expect(hop.headers["set-cookie"]).toBeUndefined();
  });

  it("decodes the body with the charset the server or page declares", async () => {
    const hop = await get("/latin");
    expect(bodyText(hop.body, hop.headers["content-type"])).toBe("Fran\u00e7ais caf\u00e9");
    expect(bodyText(Buffer.from('<meta charset="windows-1252"><p>caf\u00e9</p>', "latin1"))).toContain("caf\u00e9");
    expect(bodyText(Buffer.from("caf\u00e9"), "text/html; charset=nonsense")).toBe("caf\u00e9");
  });
});

describe("web_read reader on odd responses", () => {
  const one = (hop: Partial<Hop>): Transport => async () => ({ status: 200, headers: {}, body: Buffer.alloc(0), truncated: false, ...hop });

  it("follows Location only on a redirect status", async () => {
    const ok = await createWebReader({ transport: one({ headers: { "content-type": "text/plain", location: "/elsewhere" }, body: Buffer.from("own body") }) }).read("https://example.com/a");
    expect(ok).toMatchObject({ status: "ok", text: "own body" });
    const gone = await createWebReader({ transport: one({ status: 404, headers: { "content-type": "text/plain", location: "/elsewhere" }, body: Buffer.from("nope") }) }).read("https://example.com/b");
    expect(gone.status).toBe("blocked");
  });

  it("keeps a huge title inside the output limit and the page text after it", async () => {
    const html = `<title>${"t".repeat(100_000)}</title><p>${"hello world ".repeat(40)}</p>`;
    const out = await createWebReader({ transport: one({ headers: { "content-type": "text/html" }, body: Buffer.from(html) }) }).read("https://example.com/c");
    expect(out.text.length).toBeLessThan(TEXT_CAP);
    expect(out.text).toContain("hello world");
  });

  it("converts 2 MB of unclosed markup in about a second", () => {
    for (const unit of ["<a ", "<script ", "<!--", "<title", "<p>x</p><i ", "<article ", "<main>"]) {
      const html = unit.repeat(Math.ceil(2_000_000 / unit.length));
      const started = Date.now();
      htmlToText(html);
      expect(Date.now() - started, unit).toBeLessThan(1500);
    }
  });
});

describe("hostile PDFs", () => {
  it.each(["stream\n", "BT ", "BT [(", "<<", ">>stream\nBT [( ET endstream "])("reads 2 MB of %j in about a second", (unit) => {
    const started = Date.now();
    pdfToText(Buffer.from(`%PDF-1.4\n${unit.repeat(Math.ceil(2_000_000 / unit.length))}`, "latin1"));
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("refuses a content stream that inflates past 8 MB", () => {
    const zipped = deflateSync(Buffer.alloc(200_000_000));
    const before = process.memoryUsage().rss;
    expect(pdfToText(Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj << /Filter /FlateDecode >> stream\n"), zipped, Buffer.from("endstream")]))).toBe("");
    expect(process.memoryUsage().rss - before).toBeLessThan(100_000_000);
  });
});

describe("web_read address checks ported from read_url", () => {
  it.each(["http://intranet/", "http://printer.local/", "http://2130706433/", "http://0x7f.1/", "http://[::ffff:10.0.0.1]/", "http://[::7f00:1]/", "http://[2002:7f00:1::]/", "ftp://example.com/"])("refuses %s", (url) => {
    expect(refusedTarget(new URL(url))).toBeTruthy();
  });

  it("keeps public addresses reachable and catches IPv4 hidden in IPv6", () => {
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "64:ff9b::808:808"]) expect(privateAddress(address), address).toBe(false);
    for (const address of ["::7f00:1", "::ffff:0:7f00:1", "64:ff9b:1::7f00:1", "2002:7f00:1::", "64:ff9b::a00:1"]) expect(privateAddress(address), address).toBe(true);
  });

  it("refuses a name whose DNS answer mixes public and private addresses", async () => {
    const lookup = guardedLookup(((_h: string, _o: unknown, done: (e: null, a: { address: string; family: number }[]) => void) =>
      done(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }])) as never);
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => lookup("evil.example.com", {}, (e) => resolve(e)));
    expect(error?.code).toBe("EPRIVATE");
  });
});
