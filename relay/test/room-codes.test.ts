import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeFrame, readyMessageSchema, ROOM_CODE_RE, ROOM_CODE_TTL_MS, type RelayMessage } from "../../shared/relay-protocol.ts";
import { ROOM_CODES_PER_LABEL, RoomCodeStore } from "../src/room-codes.ts";
import { makePc, openControl, startRelay, type Control, type Harness } from "./fixtures.ts";

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function lookup(harness: Harness, code: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: harness.port, servername: `relay.${harness.base}`, ca: harness.ca.certPem, method: "GET", path: `/v1/room-codes/${code}`, agent: false, headers: { host: `relay.${harness.base}` } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function mint(ctl: Control, id = "r1"): Promise<RelayMessage | null> {
  ctl.socket.write(encodeFrame({ type: "roomcode", id }));
  return ctl.reader.next();
}

describe("room codes over the control channel", () => {
  it("offers room codes, and an old PC strips the offer", async () => {
    h = await startRelay();
    const ctl = await openControl(h, makePc());
    expect(ctl.ready.roomCodes).toBe(true);
    expect(readyMessageSchema.omit({ roomCodes: true }).parse(ctl.ready)).not.toHaveProperty("roomCodes");
    ctl.socket.destroy();
  });

  it("mints a code that looks up to the PC's label and never logs it", async () => {
    h = await startRelay();
    const pc = makePc();
    const ctl = await openControl(h, pc);
    const reply = await mint(ctl);
    expect(reply).toMatchObject({ type: "roomcoded", id: "r1" });
    const { code, exp } = reply as { code: string; exp: number };
    expect(code).toMatch(ROOM_CODE_RE);
    expect(Math.abs(exp - (Date.now() + ROOM_CODE_TTL_MS))).toBeLessThan(60_000);
    expect(await lookup(h, code)).toEqual({ status: 200, body: { label: pc.label } });
    expect(h.logs.join("\n")).not.toContain(code);
    ctl.socket.destroy();
  });

  it("answers a wrong, lowercase or malformed code with not-found", async () => {
    h = await startRelay();
    const ctl = await openControl(h, makePc());
    const { code } = (await mint(ctl)) as { code: string };
    for (const bad of [code.toLowerCase(), "AAAAAO", "ABC", "%2E%2E"]) expect((await lookup(h, bad)).status).toBe(404);
    ctl.socket.destroy();
  });

  it("refuses a code past its expiry", async () => {
    let shift = 0;
    h = await startRelay({ now: () => Date.now() + shift });
    const ctl = await openControl(h, makePc());
    const { code } = (await mint(ctl)) as { code: string };
    shift = ROOM_CODE_TTL_MS - 60_000;
    expect((await lookup(h, code)).status).toBe(200);
    shift = ROOM_CODE_TTL_MS + 1;
    expect(await lookup(h, code)).toEqual({ status: 404, body: { error: "not-found" } });
    ctl.socket.destroy();
  });

  it("rate-limits lookups per address and relay-wide", async () => {
    h = await startRelay({ limits: { roomCodeLookupsPerIpPerMin: 3 } });
    for (let i = 0; i < 3; i++) expect((await lookup(h, "ABCDEF")).status).toBe(404);
    expect(await lookup(h, "ABCDEF")).toEqual({ status: 429, body: { error: "rate-limited" } });
    await h.close();

    h = await startRelay({ limits: { roomCodeLookupsPerHour: 2 } });
    for (let i = 0; i < 2; i++) expect((await lookup(h, "ABCDEF")).status).toBe(404);
    expect((await lookup(h, "ABCDEF")).status).toBe(429);
  });
});

describe("room code store", () => {
  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wink-room-codes-"));
    dirs.push(dir);
    return dir;
  }

  it("keeps live codes across a restart and drops expired ones", async () => {
    const dir = await tempDir();
    let now = 1_000_000;
    const store = await RoomCodeStore.open(dir, () => now);
    const one = store.mint("aaaaaaaaaaaaaaaa")!;
    now += ROOM_CODE_TTL_MS / 2;
    const two = store.mint("bbbbbbbbbbbbbbbb")!;
    await store.close();
    now += ROOM_CODE_TTL_MS / 2;
    const again = await RoomCodeStore.open(dir, () => now);
    expect(again.lookup(one.code)).toBeNull();
    expect(again.lookup(two.code)).toBe("bbbbbbbbbbbbbbbb");
    await again.close();
  });

  it("caps live codes per PC", async () => {
    const store = await RoomCodeStore.open(await tempDir());
    for (let i = 0; i < ROOM_CODES_PER_LABEL; i++) expect(store.mint("aaaaaaaaaaaaaaaa")).not.toBeNull();
    expect(store.mint("aaaaaaaaaaaaaaaa")).toBeNull();
    expect(store.mint("bbbbbbbbbbbbbbbb")).not.toBeNull();
    await store.close();
  });
});
