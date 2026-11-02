import { describe, expect, it } from "vitest";
import { devicesSetup } from "./devices-setup";
import type { RemotePhoneLink } from "./phone-setup";

describe("Devices setup progress", () => {
  it.each([
    ["missing", undefined, false, false, false],
    ["not-running", "NeedsLogin", true, false, false],
    ["not-running", "NeedsMachineAuth", true, false, false],
    ["serve-disabled", "Running", true, true, false],
    ["ready", "Running", true, true, true],
  ] as const)("derives %s / %s", (state, backendState, installed, signedIn, ready) => {
    const result = devicesSetup({ url: state === "ready" ? "https://fixture.invalid/remote" : null, setup: { state, backendState } });
    expect(result).toMatchObject({ installed, signedIn, ready, canSignIn: backendState === "NeedsLogin" });
  });

  it("keeps browser completion separate from admin approval", () => {
    expect(devicesSetup({ url: null, setup: { state: "not-running", backendState: "NeedsLogin" } }, true)).toMatchObject({ loginOpened: true, canSignIn: false, signedIn: false });
    expect(devicesSetup({ url: null, setup: { state: "not-running", backendState: "NeedsMachineAuth" } }, true)).toMatchObject({ loginOpened: false, needsApproval: true, canSignIn: false });
  });

  it("does not offer to configure an existing node key", () => {
    expect(devicesSetup({ url: null, setup: { state: "not-running", backendState: "NeedsLogin", haveNodeKey: true } }).canSignIn).toBe(false);
  });

  it("distinguishes phone joined, phone opened Wink and another PC online", () => {
    const status: RemotePhoneLink = { url: "https://fixture.invalid", setup: { state: "ready", phoneJoined: true } };
    expect(devicesSetup(status)).toMatchObject({ phoneJoined: true, phoneOpened: false, pcOnline: false });
    status.phones = [{ id: "fixture", kind: "iphone", lastSeen: 1 }];
    status.pcs = [{ name: "Laptop", host: "laptop.tail1234.ts.net" }];
    expect(devicesSetup(status)).toMatchObject({ phoneJoined: true, phoneOpened: true, pcOnline: true });
  });
});
