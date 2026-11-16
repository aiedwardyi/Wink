import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { deliverMailboxOutbox } from "./mailbox-outbox.mjs";
import { createPaneRuns } from "./pane-runs.mjs";

const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve));
});

async function fixture(status = 200) {
  const profile = await fs.mkdtemp(path.join(os.homedir(), "outbox-"));
  const dir = path.join(profile, "mailbox-outbox");
  await fs.mkdir(dir);
  const posts = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    posts.push(JSON.parse(text));
    res.writeHead(status).end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const entry = at => ({ url, headers: { authorization: "Bearer throwaway", "x-orbit-pane": "pane", "x-orbit-bot": "bot", "x-orbit-teacher": "bot" }, payload: { messageId: randomUUID(), sentAt: at, queued: true, text: "finished", kind: "report" } });
  const write = async (at, value = entry(at)) => {
    const file = path.join(dir, `${at}-${randomUUID()}.json`);
    await fs.writeFile(file, JSON.stringify(value));
    return file;
  };
  return { profile, dir, posts, url, entry, write };
}

it("prunes older than seven days and caps delivery at the newest 500 files", async () => {
  const f = await fixture();
  const now = Date.now();
  await f.write(now - 8 * 86_400_000);
  for (let index = 0; index < 503; index++) await f.write(now - index);
  const result = await deliverMailboxOutbox(f.profile, f.url);
  expect(result.delivered).toBe(500);
  expect(f.posts).toHaveLength(500);
  expect(f.posts.every(post => post.sentAt > now - 503)).toBe(true);
  expect((await fs.readdir(f.dir)).filter(file => file.endsWith(".json"))).toEqual([]);
}, 30_000);

it("keeps unacknowledged entries and their IDs for the next delivery", async () => {
  const f = await fixture(503);
  const file = await f.write(Date.now());
  const before = await fs.readFile(file, "utf8");
  expect((await deliverMailboxOutbox(f.profile, f.url)).delivered).toBe(0);
  expect(await fs.readFile(file, "utf8")).toBe(before);
});

it("retires only the acknowledged prior report before worker recovery", async () => {
  const f = await fixture();
  const ledger = path.join(f.profile, "pane-runs.json");
  await fs.writeFile(ledger, JSON.stringify([
    { id: "pane", botId: "bot", teacher: "bot", state: "running" },
    { id: "other", botId: "bot", teacher: "bot", state: "running" },
  ]));
  await f.write(Date.now());
  const runs = createPaneRuns(ledger);
  await deliverMailboxOutbox(f.profile, f.url, runs);
  expect(runs.restarted().get("bot").map(run => run.id)).toEqual(["other"]);
  expect(createPaneRuns(ledger).restarted().get("bot").map(run => run.id)).toEqual(["other"]);
});

it("delivers after a sender crash leaves a fresh lock file", async () => {
  const f = await fixture();
  await f.write(Date.now());
  await fs.writeFile(path.join(f.profile, "mailbox-outbox.lock"), "");
  expect((await deliverMailboxOutbox(f.profile, f.url)).delivered).toBe(1);
  expect(f.posts).toHaveLength(1);
});

it.skipIf(process.platform !== "win32")("waits for a live sender's Windows sharing lock", async () => {
  const f = await fixture();
  await f.write(Date.now());
  const file = path.join(f.profile, "mailbox-outbox.lock").replaceAll("'", "''");
  const script = `$lock = [IO.File]::Open('${file}', [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); [Console]::Out.WriteLine('locked'); [void][Console]::In.ReadLine(); $lock.Dispose()`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise(resolve => child.once("close", resolve));
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  const ready = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error(errors || "sender exited before locking")));
    child.stdout.on("data", chunk => { if (String(chunk).includes("locked")) resolve(); });
  });
  try {
    await ready;
    expect(await deliverMailboxOutbox(f.profile, f.url, undefined, { budgetMs: 200 })).toMatchObject({ delivered: 0, unreadable: true });
    expect(f.posts).toEqual([]);
    const delivering = deliverMailboxOutbox(f.profile, f.url);
    child.stdin.end("release\n");
    await exited;
    expect((await delivering).delivered).toBe(1);
  } finally {
    if (!child.stdin.writableEnded) child.stdin.end("release\n");
    await exited;
  }
});

it("does nothing on an absent outbox and rejects remote drain destinations", async () => {
  const profile = await fs.mkdtemp(path.join(os.homedir(), "empty-outbox-"));
  expect((await deliverMailboxOutbox(profile, "http://127.0.0.1:1")).delivered).toBe(0);
  expect(await fs.readdir(profile)).toEqual([]);
  await expect(deliverMailboxOutbox(profile, "https://example.com")).rejects.toThrow();
});

it("does not follow symlinks, malformed entries or HTTP redirects with pane credentials", async () => {
  const f = await fixture(302);
  const outside = path.join(f.profile, "outside.json");
  await fs.writeFile(outside, JSON.stringify(f.entry(Date.now())));
  const symlink = path.join(f.dir, `${Date.now()}-${randomUUID()}.json`);
  try { await fs.symlink(outside, symlink); } catch (error) { if (error.code !== "EPERM") throw error; }
  await f.write(Date.now(), { broken: true });
  const valid = await f.write(Date.now());
  await deliverMailboxOutbox(f.profile, f.url);
  expect(await fs.readFile(outside, "utf8")).toContain("throwaway");
  expect(await fs.readFile(valid, "utf8")).toContain("throwaway");
  expect(f.posts).toHaveLength(1);
});
