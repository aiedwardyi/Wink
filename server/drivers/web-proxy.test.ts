import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { guardedLookup, htmlToText, PUBLIC_ONLY, readUrl, TOOLS } from "./web-proxy.ts";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "web-proxy.ts");
const ANY = { blocks: () => false };

let site: Server;
let base = "";
const page = (body: string) => `<!doctype html><html><head><title>Example &amp; Co</title><style>p{color:red}</style><script>var secret=1</script></head><body>${body}</body></html>`;

beforeAll(async () => {
  site = createServer((req, res) => {
    if (req.url === "/page") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("<h1>Hello</h1><p>First &amp; second</p><p>Third</p>"));
    if (req.url === "/big") return res.writeHead(200, { "content-type": "text/plain" }).end("x".repeat(200_000));
    if (req.url === "/json") return res.writeHead(200, { "content-type": "application/json" }).end('{"a":1}');
    if (req.url === "/img") return res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([1, 2, 3]));
    if (req.url === "/gone") return res.writeHead(404, { "content-type": "text/plain" }).end("nope");
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
    const hop = await readUrl(`${base}/hop`, { blocks: (address) => address === "127.0.0.1" });
    expect(hop).toMatchObject({ isError: true });
  });

  it("refuses a name that resolves to a private address (DNS rebinding)", async () => {
    const lookup = guardedLookup(PUBLIC_ONLY, ((_host: string, _options: unknown, done: (e: null, a: { address: string; family: number }[]) => void) =>
      done(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }])) as never);
    const error = await new Promise<Error | null>((resolve) => lookup("evil.example.com", {}, (e) => resolve(e)));
    expect(error?.message).toContain("private or local");
    const good = await new Promise<unknown>((resolve) =>
      guardedLookup(PUBLIC_ONLY, ((_h: string, _o: unknown, done: (e: null, a: { address: string; family: number }[]) => void) =>
        done(null, [{ address: "93.184.216.34", family: 4 }])) as never)("example.com", {}, (_e, a) => resolve(a)),
    );
    expect(good).toBe("93.184.216.34");
  });

  it("htmlToText keeps block breaks and decodes entities", () => {
    expect(htmlToText("<title>T&#33;</title><body><p>a&nbsp;b</p><p>c</p></body>")).toEqual({ title: "T!", text: "a b\n\nc" });
  });
});

describe("web-proxy stdio", () => {
  it("lists read_url as the only tool, marked read-only", async () => {
    const child = spawn(process.execPath, [PROXY], { stdio: ["pipe", "pipe", "inherit"] });
    const reply = new Promise<any>((resolve) => child.stdout.once("data", (chunk) => resolve(JSON.parse(String(chunk)))));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const message = await reply;
    child.kill();
    expect(message.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["read_url"]);
    expect(TOOLS[0].annotations.readOnlyHint).toBe(true);
  });
});
