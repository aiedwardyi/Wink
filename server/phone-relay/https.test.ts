import { createServer, type Server } from "node:https";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { httpsRequest, type HttpsDeps } from "./https.ts";
import { loopbackLookup } from "./testing/fake-relay.ts";
import { listenLocal } from "./testing/net.ts";
import { TestCa } from "./testing/pki.ts";

const HOST = "abcdefghijklmnop.wink.test";

let server: Server;
let deps: HttpsDeps;
let other: TestCa;
let seen: IncomingHttpHeaders = {};
let handler: (req: IncomingMessage, res: ServerResponse) => void = () => {};

beforeAll(async () => {
  const ca = await TestCa.create();
  other = await TestCa.create("Someone Else");
  const { keyPem, certPem } = await ca.issue(HOST);
  server = createServer({ key: keyPem, cert: certPem }, (req, res) => {
    seen = req.headers;
    handler(req, res);
  });
  deps = { ca: ca.certPem, lookup: loopbackLookup, port: await listenLocal(server) };
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const get = (overrides: Partial<Parameters<typeof httpsRequest>[0]> = {}, using = deps) =>
  httpsRequest({ method: "GET", url: `https://${HOST}/x`, timeoutMs: 2_000, maxBytes: 1_000, ...overrides }, using);

describe("httpsRequest", () => {
  it("sends extra headers", async () => {
    handler = (_req, res) => res.end("{}");
    await get({ method: "POST", body: "{}", headers: { authorization: "Bearer k1", origin: `https://${HOST}` } });
    expect(seen).toMatchObject({ authorization: "Bearer k1", origin: `https://${HOST}`, "content-type": "application/json" });
  });

  it("refuses a certificate from an untrusted root or for another name", async () => {
    handler = (_req, res) => res.end("{}");
    await expect(get({}, { ...deps, ca: other.certPem })).rejects.toThrow();
    await expect(get({ url: "https://bcdefghijklmnopq.wink.test/x" })).rejects.toThrow();
  });

  it("refuses any redirect by default", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: `https://${HOST}/y` });
      res.end();
    };
    await expect(get()).rejects.toThrow("unexpected redirect 302");
  });

  it("gives up at the deadline", async () => {
    handler = () => {};
    await expect(get({ timeoutMs: 100 })).rejects.toThrow("request timed out");
  });
});
