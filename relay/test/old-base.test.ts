import { request } from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { BASE, captureClientHello, event, makePc, openControl, openData, rawConnect, startRelay, type Harness } from "./fixtures.ts";
import { awaitGo, phoneConnect, serveInner } from "./pc-side.ts";

// The relay's base is the new name; the fixture helpers speak the old one, like a PC set up before the move.
const NEW = "app.relay-test.example";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function status(h: Harness, label: string, origin: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: h.port,
        servername: `relay.${BASE}`,
        ca: h.ca.certPem,
        path: `/v1/status/${label}`,
        agent: false,
        headers: { host: `relay.${BASE}`, origin },
      },
      (res) => {
        res.resume();
        const allowed = res.headers["access-control-allow-origin"];
        res.on("end", () => resolve(Array.isArray(allowed) ? allowed[0] : allowed));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("old base kept beside the new one", () => {
  it("lets a PC on the old base connect and a phone with the old icon open it", async () => {
    h = await startRelay({ base: NEW, oldBases: [BASE] });
    const pc = makePc();
    const pcCert = await h.ca.issue(`${pc.label}.${BASE}`);
    const ctl = await openControl(h, pc);
    const data = await openData(h, ctl.ready.session, ctl.ready.poolToken);
    await h.waitLog(event("join", { label: pc.label }));
    const inner = serveInner(data, pcCert);
    const phone = await phoneConnect(h, pc.label);
    await inner;
    expect(phone.getPeerCertificate().subject.CN).toBe(`${pc.label}.${BASE}`);
    phone.destroy();
    ctl.socket.destroy();
  });

  it("routes the new name to the same PC", async () => {
    h = await startRelay({ base: NEW, oldBases: [BASE] });
    const pc = makePc();
    const ctl = await openControl(h, pc);
    const data = await openData(h, ctl.ready.session, ctl.ready.poolToken);
    await h.waitLog(event("join", { label: pc.label }));
    const phone = await rawConnect(h);
    const got = awaitGo(data);
    phone.write(await captureClientHello(`${pc.label}.${NEW}`));
    expect((await got).go.type).toBe("go");
    phone.destroy();
    ctl.socket.destroy();
  });

  it("lets both origins read the offline status, and no other", async () => {
    h = await startRelay({ base: NEW, oldBases: [BASE] });
    const pc = makePc();
    expect(await status(h, pc.label, `https://${pc.label}.${NEW}`)).toBe(`https://${pc.label}.${NEW}`);
    expect(await status(h, pc.label, `https://${pc.label}.${BASE}`)).toBe(`https://${pc.label}.${BASE}`);
    expect(await status(h, pc.label, `https://${pc.label}.other.example`)).toBeUndefined();
  });

  it("still refuses names under any other base", async () => {
    h = await startRelay({ base: NEW, oldBases: [BASE] });
    const pc = makePc();
    const phone = await rawConnect(h);
    phone.on("error", () => {});
    phone.write(await captureClientHello(`${pc.label}.other.example`));
    await h.waitLog(event("phone-rejected", { reason: "unknown-sni" }));
    phone.destroy();
  });
});
