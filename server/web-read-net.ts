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

// Ranges and the embedded-IPv4 forms follow the earlier read_url reader (PR 1821).
const NON_PUBLIC = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) NON_PUBLIC.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 96], ["64:ff9b:1::", 48], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) NON_PUBLIC.addSubnet(net, bits, "ipv6");

/** Loopback, private, link-local, CGNAT, multicast and reserved addresses, v4 and v6, including IPv4 carried inside IPv6. */
export function privateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(bare);
  if (!version) return false;
  const embedded = /^(?:::ffff:(?:0:)?|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(bare)?.[1];
  if (embedded) return NON_PUBLIC.check(embedded, "ipv4");
  // Node's parser keeps IPv4-mapped addresses in hex (::ffff:7f00:1).
  const hex = /^(?:::ffff:(?:0:)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (hex) {
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    return NON_PUBLIC.check(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, "ipv4");
  }
  return NON_PUBLIC.check(bare, version === 4 ? "ipv4" : "ipv6");
}

/** Why a URL may not be read, or null. Every redirect hop is checked again. */
export function refusedTarget(url: URL): string | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return `only http(s) links are read, not ${url.protocol}`;
  if (url.username || url.password) return "links with a login in them are not read";
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(host)) return privateAddress(host) ? "a local or private address" : null;
  if (host === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host) || !host.includes(".")) return "a local or private address";
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
        res.resume();
        return resolve({ status, headers: flat, body: Buffer.alloc(0), truncated: false });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (truncated: boolean) => {
        if (done) return;
        done = true;
        resolve({ status, headers: flat, body: Buffer.concat(chunks), truncated });
      };
      const fail = (error: Error) => {
        if (done) return;
        if (chunks.length) return finish(true);
        done = true;
        reject(error);
      };
      // pipe() does not pass a dropped connection on to the decoder, so watch the response itself.
      res.on("error", fail);
      res.on("close", () => (res.complete ? undefined : fail(new Error("the connection closed mid-page"))));
      const stream = decoded(res);
      stream.on("data", (chunk: Buffer) => {
        if (done) return;
        const room = MAX_BODY_BYTES - size;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        size += chunk.length;
        if (size >= MAX_BODY_BYTES) {
          finish(true);
          res.destroy();
        }
      });
      stream.on("end", () => finish(false));
      stream.on("error", fail);
    });
    req.on("error", reject);
    req.end(body);
  });
