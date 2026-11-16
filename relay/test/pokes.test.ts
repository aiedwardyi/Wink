import { afterEach, describe, expect, it } from "vitest";
import { googleSubHash } from "../../shared/google-id-token.ts";
import { authMessageSchema, encodeFrame, readyMessageSchema, signAccountTicket } from "../../shared/relay-protocol.ts";
import { closed, event, makePc, openControl, openData, startRelay, type Control, type Harness } from "./fixtures.ts";
import { phoneConnect, serveInner } from "./pc-side.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function account(harness: Harness, label: string, sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signAccountTicket({ label, subHash: googleSubHash(sub), iat: now, exp: now + 86_400 }, harness.operator);
}

async function pc(harness: Harness, sub: string | null, pokes: boolean): Promise<Control> {
  const it = makePc();
  return openControl(harness, it, { account: sub ? account(harness, it.label, sub) : undefined, pokes });
}

function poke(ctl: Control): void {
  ctl.socket.write(encodeFrame({ type: "poke" }));
}

/** Frames the relay sent before answering a fresh ping. Control frames arrive in order, so this is everything sent so far. */
async function drain(ctl: Control): Promise<string[]> {
  ctl.socket.write(encodeFrame({ type: "ping" }));
  const seen: string[] = [];
  for (;;) {
    const frame = await ctl.reader.next();
    if (!frame) throw new Error("control closed");
    if (frame.type === "pong") return seen;
    seen.push(frame.type);
  }
}

describe("pokes between pcs of one account", () => {
  it("leaves an old relay's auth schema working: it strips pokes", () => {
    const auth = { type: "auth", label: "a", pk: "b", ticket: "c", sig: "d", pokes: true } as const;
    expect(authMessageSchema.parse(auth).pokes).toBe(true);
    expect(authMessageSchema.omit({ pokes: true }).parse(auth)).not.toHaveProperty("pokes");
  });

  it("offers pokes in ready and forwards a poke to the other pc of the same account", async () => {
    h = await startRelay();
    const home = await pc(h, "edward", true);
    const work = await pc(h, "edward", true);
    expect(home.ready.pokes).toBe(true);
    poke(home);
    expect(await work.reader.next()).toEqual({ type: "poked" });
    home.socket.destroy();
    work.socket.destroy();
  });

  it("never forwards across accounts, back to the sender, or from a pc with no account", async () => {
    h = await startRelay();
    const home = await pc(h, "edward", true);
    const work = await pc(h, "edward", true);
    const stranger = await pc(h, "someone-else", true);
    const loner = await pc(h, null, true);
    poke(loner);
    expect(await drain(loner)).toEqual([]);
    expect(await drain(work)).toEqual([]);
    poke(home);
    expect(await drain(home)).toEqual([]);
    expect(await drain(work)).toEqual(["poked"]);
    expect(await drain(stranger)).toEqual([]);
    for (const c of [home, work, stranger, loner]) c.socket.destroy();
  });

  it("skips a pc of the same account whose auth did not ask for pokes, and keeps it connected", async () => {
    h = await startRelay();
    const home = await pc(h, "edward", true);
    const it = makePc();
    const old = await openControl(h, it, { account: account(h, it.label, "edward"), pokes: false });
    poke(home);
    expect(await drain(home)).toEqual([]);
    expect(await drain(old)).toEqual([]);
    expect(h.relay.hub.status(it.label).online).toBe(true);
    home.socket.destroy();
    old.socket.destroy();
  });

  it("forwards a burst of 20 pokes at most twice", { timeout: 15_000 }, async () => {
    h = await startRelay();
    const home = await pc(h, "edward", true);
    const work = await pc(h, "edward", true);
    for (let i = 0; i < 20; i++) poke(home);
    // The relay has read all 20 inside the interval, so nothing is left to forward after the one trailing poke.
    expect(await drain(home)).toEqual([]);
    expect(h.logs.filter((line) => JSON.parse(line).event === "poked")).toHaveLength(1);
    await h.waitLog(event("poked"), 2);
    expect(await drain(work)).toEqual(["poked", "poked"]);
    expect(h.logs.filter((line) => JSON.parse(line).event === "poked")).toHaveLength(2);
    home.socket.destroy();
    work.socket.destroy();
  });

  it("logs a count only", async () => {
    h = await startRelay();
    const home = await pc(h, "edward", true);
    const work = await pc(h, "edward", true);
    poke(home);
    await h.waitLog(event("poked", { count: 1 }));
    const line = JSON.parse(h.logs.find((l) => JSON.parse(l).event === "poked")!);
    expect(Object.keys(line).sort()).toEqual(["count", "event", "t"]);
    home.socket.destroy();
    work.socket.destroy();
  });

  it("serves an old pc that never asks for pokes exactly as before", async () => {
    h = await startRelay();
    const fresh = await pc(h, "edward", true);
    const it = makePc();
    const old = await openControl(h, it, { account: account(h, it.label, "edward") });
    // A PC from before pokes parses ready with its old schema, which strips the field.
    expect(readyMessageSchema.omit({ pokes: true }).parse(fresh.ready)).not.toHaveProperty("pokes");
    const data = await openData(h, old.ready.session, old.ready.poolToken);
    await h.waitLog(event("join", { label: it.label }));
    poke(fresh);
    expect(await drain(fresh)).toEqual([]);
    const inner = serveInner(data, await h.ca.issue(`${it.label}.${h.base}`));
    const phone = await phoneConnect(h, it.label);
    const pcSide = await inner;
    pcSide.on("data", (chunk: Buffer) => pcSide.write(`echo:${chunk}`));
    phone.write("hi");
    expect(await new Promise<string>((resolve) => phone.once("data", (c: Buffer) => resolve(c.toString())))).toBe("echo:hi");
    expect(await drain(old)).toEqual([]);
    phone.end();
    await closed(phone);
    fresh.socket.destroy();
    old.socket.destroy();
  });
});
