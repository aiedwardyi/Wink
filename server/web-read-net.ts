// web_read's only way out to the network: GET, no cookies, public addresses only.
// The one POST is YouTube's own player API (POST_URLS), which hands out caption links plain page reads no longer get.
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";

export const MAX_BODY_BYTES = 2_000_000;

export type Hop = { status: number; headers: Record<string, string>; body: Buffer; truncated: boolean };
/** With a body the request is a POST, and only to a POST_URLS address. */
export type Transport = (url: URL, headers: Record<string, string>, signal: AbortSignal, body?: Buffer) => Promise<Hop>;

export const POST_URLS: ReadonlySet<string> = new Set(["https://www.youtube.com/youtubei/v1/player"]);

// Ranges follow the earlier read_url reader (PR 1821), plus NAT64, Teredo, discard and documentation ranges.
const NON_PUBLIC = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) NON_PUBLIC.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) NON_PUBLIC.addSubnet(net, bits, "ipv6");

/** The 16 bytes of an IPv6 address in any spelling (compressed, zone id, dotted IPv4 tail), or null. */
function ipv6Bytes(address: string): number[] | null {
  let text = address.split("%")[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (dotted) {
    if (isIP(dotted) !== 4) return null;
    const [a, b, c, d] = dotted.split(".").map(Number) as [number, number, number, number];
    text = text.slice(0, -dotted.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string) => (half ? half.split(":") : []);
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const words = [...head, ...Array<string>(fill).fill("0"), ...tail].map((word) => parseInt(word, 16));
  if (words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  return words.flatMap((word) => [word >> 8, word & 255]);
}

/** Loopback, private, link-local, CGNAT, multicast and reserved addresses, v4 and v6, including IPv4 carried inside IPv6. Anything that is not an address counts as private. */
export function privateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(bare);
  if (version === 4) return NON_PUBLIC.check(bare, "ipv4");
  if (version !== 6) return true;
  const bytes = ipv6Bytes(bare);
  if (!bytes) return true;
  const zeros = (count: number) => bytes.slice(0, count).every((byte) => byte === 0);
  const inner = () => NON_PUBLIC.check(bytes.slice(12).join("."), "ipv4");
  // IPv4-mapped ::ffff:a.b.c.d, SIIT ::ffff:0:a.b.c.d and NAT64 64:ff9b::a.b.c.d: judge the IPv4 inside.
  if (zeros(10) && bytes[10] === 255 && bytes[11] === 255) return inner();
  if (zeros(8) && bytes[8] === 255 && bytes[9] === 255 && bytes[10] === 0 && bytes[11] === 0) return inner();
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((byte) => byte === 0)) return inner();
  const canonical = Array.from({ length: 8 }, (_, i) => ((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!).toString(16)).join(":");
  return NON_PUBLIC.check(canonical, "ipv6");
}

/** Why a URL may not be read, or null. Every redirect hop is checked again. */
export function refusedTarget(url: URL): string | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return `only http(s) links are read, not ${url.protocol}`;
  if (url.username || url.password) return "links with a login in them are not read";
  // Any number of trailing dots ("localhost..") names the same host.
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (isIP(host)) return privateAddress(host) ? "a local or private address" : null;
  if (host === "localhost" || /\.(localhost|localdomain|local|internal|lan|home\.arpa)$/.test(host) || !host.includes(".") || host.includes("..")) return "a local or private address";
  return null;
}

type Resolve = (hostname: string, options: LookupAllOptions, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/** Fails the connection when any address the name resolves to is private, so DNS cannot point a public name inward. */
export function guardedLookup(resolve: Resolve = dnsLookup as unknown as Resolve): LookupFunction {
  return ((hostname: string, options: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) => {
    resolve(hostname, { family: options.family ?? 0, all: true } as LookupAllOptions, (error, addresses) => {
      if (error) return callback(error);
      const list = addresses ?? [];
      if (!list.length || list.some((entry) => privateAddress(entry.address))) {
        return callback(Object.assign(new Error(`${hostname} resolves to a private address`), { code: "EPRIVATE" }));
      }
      if (options.all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  }) as LookupFunction;
}

function decoded(res: http.IncomingMessage): Readable {
  const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") return res.pipe(createGunzip());
  if (encoding === "deflate") return res.pipe(createInflate());
  if (encoding === "br") return res.pipe(createBrotliDecompress());
  return res;
}

/** One GET (or a POST to a POST_URLS address), no redirect following; the caller checks each hop. Bodies stop at MAX_BODY_BYTES after decoding. */
export const nodeTransport: Transport = (url, headers, signal, body) =>
  new Promise((resolve, reject) => {
    if (body && !POST_URLS.has(url.origin + url.pathname)) return reject(new Error(`web_read only POSTs to YouTube's player API, not ${url.origin}${url.pathname}`));
    const client = url.protocol === "https:" ? https : http;
    const sent = body ? { ...headers, "content-length": String(body.length) } : headers;
    const req = client.request(url, { method: body ? "POST" : "GET", headers: sent, lookup: guardedLookup(), signal, agent: false }, (res) => {
      const flat: Record<string, string> = {};
      for (const [key, value] of Object.entries(res.headers)) if (key !== "set-cookie" && value !== undefined) flat[key] = Array.isArray(value) ? value.join(", ") : value;
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        // Only Location matters: close the connection rather than download the redirect's body.
        res.destroy();
        return resolve({ status, headers: flat, body: Buffer.alloc(0), truncated: false });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const stream = decoded(res);
      // Stops the socket and the decoder together: a decoder left running keeps inflating a compressed bomb after we answer.
      const teardown = () => {
        signal.removeEventListener("abort", aborted);
        if (stream !== res) stream.destroy();
        res.destroy();
      };
      const finish = (truncated: boolean) => {
        if (done) return;
        done = true;
        teardown();
        resolve({ status, headers: flat, body: Buffer.concat(chunks), truncated });
      };
      const fail = (error: Error) => {
        if (done) return;
        if (chunks.length) return finish(true);
        done = true;
        teardown();
        reject(error);
      };
      const aborted = () => fail(Object.assign(new Error("the read was stopped"), { name: "AbortError" }));
      signal.addEventListener("abort", aborted, { once: true });
      // pipe() does not pass a dropped connection on to the decoder, so watch the response itself.
      res.on("error", fail);
      res.on("close", () => (res.complete ? undefined : fail(new Error("the connection closed mid-page"))));
      stream.on("data", (chunk: Buffer) => {
        if (done) return;
        const room = MAX_BODY_BYTES - size;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        size += chunk.length;
        if (size >= MAX_BODY_BYTES) finish(true);
      });
      stream.on("end", () => finish(false));
      stream.on("error", fail);
    });
    req.on("error", reject);
    req.end(body);
  });
