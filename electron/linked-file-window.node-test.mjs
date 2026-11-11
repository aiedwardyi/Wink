import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { handleDeviceLinkedFile, openPeerLinkedFile } = require("./linked-file-window.cjs");
const origin = "https://home.tail1234.ts.net";
const linked = (name) => `${origin}/api/threads/t1/linked-file?path=${encodeURIComponent(`/out/${name}`)}`;

function host() {
  const win = new EventEmitter();
  const webContents = new EventEmitter();
  const calls = [];
  win.webContents = webContents;
  win.isDestroyed = () => false;
  win.show = () => calls.push("show");
  win.loadURL = async (url) => calls.push(url);
  webContents.setWindowOpenHandler = (fn) => { webContents.popup = fn; };
  webContents.downloadURL = (url) => calls.push(["download", url]);
  const actions = {
    webContents,
    createWindow: (options) => { calls.push(options); return win; },
    openFile: async (...args) => calls.push(["open", ...args]),
    log: (message) => calls.push(message),
  };
  return { win, webContents, calls, actions };
}

test("HTML opens without a preload in the authenticated partition and stays in its linked folder", () => {
  const { win, webContents, calls, actions } = host();
  const target = linked("page.html");
  assert.equal(handleDeviceLinkedFile(target, origin, actions), true);
  assert.deepEqual(calls[0].webPreferences, { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "persist:orbit-devices" });
  assert.equal(calls[1], target);
  assert.deepEqual(webContents.popup(), { action: "deny" });
  win.emit("ready-to-show");
  assert.equal(calls[2], "show");
  const canonical = `${origin}/api/threads/t1/linked-file/${encodeURIComponent("/out/page.html")}/`;
  for (const [href, denied] of [[canonical, false], [`${canonical}assets/next.html`, false], [`${origin}/api/bots`, true], [linked("other.html"), true], ["https://evil.example/", true]]) {
    let prevented = false;
    webContents.emit("will-redirect", { preventDefault: () => { prevented = true; } }, href);
    assert.equal(prevented, denied, href);
  }
});

test("other files download once without opening a native app or a window", () => {
  for (const name of ["file.zip", "notes.md", "notes.txt", "report.docx", "LICENSE"]) {
    const { calls, actions } = host();
    assert.equal(handleDeviceLinkedFile(linked(name), origin, actions), true);
    assert.deepEqual(calls, [["download", linked(name)]]);
  }
});

test("existing media opening and unrelated popups keep their behavior", () => {
  const { calls, actions } = host();
  assert.equal(handleDeviceLinkedFile(linked("notes.pdf"), origin, actions), true);
  assert.deepEqual(calls, [["open", linked("notes.pdf"), "notes.pdf"]]);
  assert.equal(handleDeviceLinkedFile("https://evil.example/", origin, actions), false);
  assert.equal(calls.length, 1);
});

test("a failed HTML load is logged without a dialog or an unhandled rejection", async () => {
  const { win, calls, actions } = host();
  win.loadURL = async () => { throw new Error("offline"); };
  handleDeviceLinkedFile(linked("page.htm"), origin, actions);
  await Promise.resolve();
  assert.equal(calls.at(-1), "device linked HTML: offline");
});

function peer(response) {
  const { calls, actions } = host();
  const session = {
    fetch: async (url, init) => {
      calls.push(["fetch", url, init.headers.Range]);
      if (response instanceof Error) throw response;
      return response;
    },
    downloadURL: (url) => calls.push(["download", url]),
  };
  const open = (name, from = "Home.tail1234.ts.net", thread = "t1") => openPeerLinkedFile(from, thread, `C:/봇 폴더/${name}`, { ...actions, session, tailnet: "tail1234.ts.net" });
  const target = (name) => `${origin}/api/threads/t1/linked-file?path=${encodeURIComponent(`C:/봇 폴더/${name}`)}`;
  return { calls, open, target };
}

test("a file on another PC opens through that PC's own link route", async () => {
  const { calls, open, target } = peer(new Response("x", { status: 206 }));
  await open("주간 보고서.docx");
  await open("요약 1.pdf");
  await open("page.html");
  assert.deepEqual(calls.slice(0, 4), [
    ["fetch", target("주간 보고서.docx"), "bytes=0-0"], ["download", target("주간 보고서.docx")],
    ["fetch", target("요약 1.pdf"), "bytes=0-0"], ["open", target("요약 1.pdf"), "요약 1.pdf"],
  ]);
  assert.equal(calls[5].webPreferences.partition, "persist:orbit-devices");
  assert.equal(calls[6], target("page.html"));
});

test("a file the other PC refuses or cannot send says why", async () => {
  const outside = peer(new Response(JSON.stringify({ error: "not found", reason: "outside" }), { status: 404 }));
  await assert.rejects(outside.open("주간 보고서.docx"), { message: "That file is outside the bot's folder" });
  for (const response of [new Response("{}", { status: 401 }), new Response("{}", { status: 404 }), new Error("offline")]) {
    const { calls, open } = peer(response);
    await assert.rejects(open("주간 보고서.docx"), { message: "That file could not be opened" });
    assert.equal(calls.length, 1);
  }
});

test("only a PC on this tailnet and a plain chat id are asked", async () => {
  const { calls, open } = peer(new Response("x", { status: 206 }));
  for (const from of ["home.other99.ts.net", "evil.example", "home.tail1234.ts.net/x"]) await assert.rejects(open("a.docx", from), /invalid/);
  await assert.rejects(open("a.docx", "home.tail1234.ts.net", "t1/../bots"), /invalid/);
  assert.deepEqual(calls, []);
});
