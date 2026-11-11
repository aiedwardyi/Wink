import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { isRoomUpload, keepRoomUploads } from "./upload-timeouts.ts";

let server: Server;

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function trickle(path: string): Promise<string> {
  server = createServer({ requestTimeout: 200, connectionsCheckingInterval: 20 }, (req, res) => {
    let bytes = 0;
    req.on("data", (chunk: Buffer) => { bytes += chunk.length; });
    req.on("end", () => res.end(`got ${bytes}`));
  });
  keepRoomUploads(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
  let reply = "";
  socket.on("data", (chunk: Buffer) => { reply += chunk.toString("latin1"); });
  socket.on("error", () => {});
  socket.write(`POST ${path} HTTP/1.1\r\nhost: localhost\r\ncontent-length: 6\r\nconnection: close\r\n\r\n`);
  for (const byte of "abcdef") {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!socket.destroyed) socket.write(byte);
  }
  if (!socket.destroyed) await once(socket, "close");
  return reply;
}

describe("room upload timeouts", () => {
  it("lets a room upload run past requestTimeout", async () => {
    const reply = await trickle("/api/joined/rooms/r1/files?name=a.pdf&uploadId=u");
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
    expect(reply).toContain("got 6");
  });

  it("still cuts any other slow request at requestTimeout", async () => {
    expect(await trickle("/api/rooms/r1/send")).not.toContain("got");
  });

  it("matches only POST uploads on the local, joined and relay routes", () => {
    const req = (method: string, url: string) => ({ method, url }) as Parameters<typeof isRoomUpload>[0];
    expect(isRoomUpload(req("POST", "/api/rooms/r1/files?name=a"))).toBe(true);
    expect(isRoomUpload(req("POST", "/api/joined/rooms/r1/files"))).toBe(true);
    expect(isRoomUpload(req("POST", "/room/v1/rooms/r1/files?uploadId=u"))).toBe(true);
    expect(isRoomUpload(req("GET", "/api/rooms/r1/files"))).toBe(false);
    expect(isRoomUpload(req("POST", "/api/rooms/r1/files/AAAAAAAAAAAAAAAAAAAAAAAA"))).toBe(false);
    expect(isRoomUpload(req("POST", "/api/rooms/r1/send"))).toBe(false);
  });
});
