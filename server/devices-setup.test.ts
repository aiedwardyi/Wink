import { describe, expect, it, vi } from "vitest";
import { autoRemoteHost, remoteHostRetry, remoteLinkSetup } from "./remote-access.ts";
import { signInTailscale, tailnetDevices, winkPeers, type TailscaleStatus } from "./tailscale-setup.ts";

const host = "home.tail1234.ts.net";
const peer = (UserID = 7, OS = "iOS", Online = true) => ({ UserID, OS, Online, DNSName: "phone.tail1234.ts.net." });
const snapshot = (BackendState = "Running", Peer = {}) => ({
  BackendState,
  Self: { DNSName: `${host}.`, UserID: 7, CapMap: { https: [] } },
  User: { "7": { LoginName: "you@example.com" } }, Peer,
});
const fake = (status: TailscaleStatus) => vi.fn(async (_file: string, args: string[]) => args[0] === "status" ? JSON.stringify(status) : "{}");

describe("Devices setup detection", () => {
  it("detects same-account peers when UserID is zero", () => {
    const status = snapshot("Running", { phone: peer(0), pc: peer(0, "windows") });
    status.Self.UserID = 0;
    expect(tailnetDevices(status)).toMatchObject({ phoneJoined: true, pcs: [{ host: "phone.tail1234.ts.net" }] });
  });

  it("preserves a configured host for callers outside Devices", () => {
    expect(remoteLinkSetup(host, { state: "checking" }, false)).toEqual({ state: "ready" });
    expect(remoteLinkSetup(host, { state: "disabled" }, true)).toEqual({ state: "ready" });
    expect(remoteLinkSetup(host, { state: "not-running" }, true)).toEqual({ state: "not-running" });
    expect(remoteLinkSetup(undefined, { state: "missing" }, false)).toEqual({ state: "missing" });
  });

  it.each(["NeedsLogin", "NeedsMachineAuth", "Running"])("exposes %s and the account", async (backendState) => {
    let setup: unknown;
    await autoRemoteHost({}, 8799, fake(snapshot(backendState)), () => {}, "linux", (value) => { setup = value; });
    expect(setup).toEqual(expect.objectContaining({ backendState, account: "you@example.com" }));
  });

  it.each([
    [{ a: peer() }, true],
    [{ a: peer(8) }, false],
    [{ a: peer(7, "android") }, true],
    [{ a: peer(7, "iOS", false) }, false],
    [{ a: peer(7, "windows") }, false],
  ])("counts only an online same-account phone (%j)", async (peers, phoneJoined) => {
    let setup: unknown;
    await autoRemoteHost({}, 8799, fake(snapshot("Running", peers)), () => {}, "linux", (value) => { setup = value; });
    expect(setup).toEqual(expect.objectContaining({ phoneJoined }));
  });

  it.each(["Running", "Stopped", "Starting", "NeedsMachineAuth", "NoState", "InUseOtherUser"])("never starts sign-in in %s", async (state) => {
    const exec = fake(snapshot(state));
    expect(await signInTailscale(exec, "win32")).toEqual({ url: null });
    expect(exec.mock.calls.map(([, args]) => args)).toEqual([["status", "--json"]]);
  });

  it("runs only up --json after a fresh NeedsLogin check", async () => {
    const exec = fake(snapshot("NeedsLogin"));
    const run = vi.fn().mockResolvedValue('{"AuthURL":"https://login.tailscale.com/a/fixture"}');
    expect(await signInTailscale(exec, "linux", run)).toEqual({ url: "https://login.tailscale.com/a/fixture" });
    expect(run).toHaveBeenCalledExactlyOnceWith("tailscale", ["up", "--json"]);
  });

  it("uses an already-issued AuthURL without a new command", async () => {
    const exec = fake({ ...snapshot("NeedsLogin"), AuthURL: "https://login.tailscale.com/a/fixture" });
    const run = vi.fn();
    expect(await signInTailscale(exec, "linux", run)).toEqual({ url: "https://login.tailscale.com/a/fixture" });
    expect(run).not.toHaveBeenCalled();
  });

  it("never runs up on a configured profile, even if it needs reauthentication", async () => {
    const run = vi.fn();
    expect(await signInTailscale(fake({ ...snapshot("NeedsLogin"), HaveNodeKey: true }), "linux", run)).toEqual({ url: null });
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts an unconfigured daemon's null Self", async () => {
    const run = vi.fn().mockResolvedValue('{"AuthURL":"https://login.tailscale.com/a/fixture"}');
    expect(await signInTailscale(fake({ BackendState: "NeedsLogin", Self: null, Peer: null, User: null }), "linux", run)).toEqual({ url: "https://login.tailscale.com/a/fixture" });
  });

  it("keeps the full AuthURL from a timed-out JSON stream", async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { stdout: '{\n"AuthURL": "https://login.tailscale.com/a/fixture"\n}' }));
    expect(await signInTailscale(fake(snapshot("NeedsLogin")), "linux", run)).toEqual({ url: "https://login.tailscale.com/a/fixture" });
  });

  it.each(["https://evil.test/a", "http://login.tailscale.com/a", "https://login.tailscale.com.evil.test/a", "https://user@login.tailscale.com/a"])("refuses sign-in URL %s", async (AuthURL) => {
    const exec = fake(snapshot("NeedsLogin"));
    expect(await signInTailscale(exec, "linux", async () => JSON.stringify({ AuthURL }))).toEqual({ url: null });
  });

  it("does not treat peers as same-account when Self has no UserID", () => {
    expect(tailnetDevices({ BackendState: "Running", Peer: { a: peer() } }).phoneJoined).toBe(false);
  });

  it("finds only online same-user PCs whose health identifies Wink", async () => {
    const status = snapshot("Running", {
      a: { ...peer(7, "windows"), DNSName: "laptop.tail1234.ts.net.", HostName: "Laptop" },
      b: { ...peer(8, "linux"), DNSName: "other.tail1234.ts.net." },
      c: { ...peer(7, "macOS", false), DNSName: "offline.tail1234.ts.net." },
      d: { ...peer(7, "linux"), DNSName: "evil.test." },
    });
    const pcs = tailnetDevices(status).pcs;
    const request = vi.fn().mockResolvedValue(Response.json({ app: "openmausbot" }));
    expect(await winkPeers(pcs, request)).toEqual([{ name: "Laptop", host: "laptop.tail1234.ts.net" }]);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValue(Response.json({ app: "another-app" }));
    expect(await winkPeers(pcs, request)).toEqual([]);
    request.mockRejectedValue(new Error("offline"));
    expect(await winkPeers(pcs, request)).toEqual([]);
  });

  it("retries Serve immediately when https capability arrives during setup", async () => {
    let https = false;
    const exec = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "status") return JSON.stringify({ ...snapshot(), Self: { DNSName: `${host}.`, UserID: 7, CapMap: https ? { https: [] } : {} } });
      if (args[1] === "status") return "{}";
      if (!https) throw new Error("Serve is not enabled https://login.tailscale.com/f/serve?node=fixture");
      return "";
    });
    const retry = remoteHostRetry({}, 8799, () => {}, exec, () => {}, "linux", () => 0);
    await retry.refresh();
    expect(retry.status().state).toBe("serve-disabled");
    exec.mockClear();
    await retry.refresh(true);
    expect(exec.mock.calls.map(([, args]) => args)).toEqual([["status", "--json"]]);
    https = true;
    await retry.refresh(true);
    expect(retry.status().state).toBe("ready");
    expect(exec).toHaveBeenCalledWith("tailscale", ["serve", "--bg", "--https=443", "http://127.0.0.1:8799"]);
  });

  it("deduplicates simultaneous sign-in requests and respects auto-off", async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => args[0] === "status" ? JSON.stringify(snapshot("NeedsLogin")) : '{"AuthURL":"https://login.tailscale.com/a/fixture"}');
    const retry = remoteHostRetry({}, 8799, () => {}, exec);
    await Promise.all([retry.signIn(), retry.signIn()]);
    expect(exec.mock.calls.filter(([, args]) => args[0] === "up")).toHaveLength(1);
    exec.mockClear();
    await remoteHostRetry({ ORBIT_REMOTE_AUTO: "0" }, 8799, () => {}, exec).signIn();
    expect(exec).not.toHaveBeenCalled();
  });

  it("detects a new PC on the next open-section poll and drops offline peers", async () => {
    let online = false;
    const exec = vi.fn(async (_file: string, args: string[]) => args[0] === "status" ? JSON.stringify(snapshot("Running", online ? { a: { ...peer(7, "windows"), DNSName: "laptop.tail1234.ts.net." } } : {})) : "{}");
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ app: "openmausbot" }));
    try {
      const retry = remoteHostRetry({}, 8799, () => {}, exec, () => {}, "linux", () => 0);
      await retry.refresh(true);
      expect(await retry.devices()).toEqual([]);
      online = true;
      await retry.refresh(true);
      expect(await retry.devices()).toEqual([{ name: "laptop", host: "laptop.tail1234.ts.net" }]);
      online = false;
      await retry.refresh(true);
      expect(await retry.devices()).toEqual([]);
    } finally { request.mockRestore(); }
  });
});
