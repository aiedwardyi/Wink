import fs from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";

import { VERIFY_IPC } from "./verify-protocol.mjs";

it("exposes four methods with frozen channels and strips the IPC event", async () => {
  const calls = [];
  let api, listener;
  const ipcRenderer = {
    invoke: async (channel) => { calls.push(channel); return { lastSeq: 1 }; },
    on: (channel, fn) => { calls.push(channel); listener = fn; },
    removeListener: (channel, fn) => { calls.push([channel, fn === listener]); },
    send: (channel, payload) => calls.push([channel, payload]),
  };
  vm.runInNewContext(fs.readFileSync(new URL("./verify-wall-preload.cjs", import.meta.url), "utf8"), { require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { expect(name).toBe("verifyWall"); api = value; } }, ipcRenderer }) });
  expect(Object.keys(api).sort()).toEqual(["close", "onEvent", "ready", "setMuted"]);
  expect(await api.ready()).toEqual({ lastSeq: 1 });
  const received = [];
  const off = api.onEvent((...values) => received.push(values));
  listener({ secret: true }, { seq: 2 }); off();
  api.setMuted(true); api.close();
  expect(received).toEqual([[{ seq: 2 }]]);
  expect(calls).toEqual([VERIFY_IPC.ready, VERIFY_IPC.event, [VERIFY_IPC.event, true], [VERIFY_IPC.mute, { muted: true }], [VERIFY_IPC.close, undefined]]);
});
