import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import { installOrbitMsg, orbitBinFiles } from "../electron/terminal-mailbox.mjs";
import { deliverMailboxOutbox } from "../electron/mailbox-outbox.mjs";
import { receiveMailboxPost } from "./mailbox-delivery.ts";
import { createMailboxReceipts } from "./mailbox-receipts.ts";
import { bootRowsNow } from "./testing/boot-rows.ts";
import { mailboxGrant } from "./mailbox.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";
import type { MailboxIdentity } from "./mailbox.ts";

const servers: Server[] = [];
const reply = z.object({ id: z.string() });
type TestReport = { text: string; kind?: string; messageId?: string; sentAt?: number; queued?: true };
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
});

async function fixture(auto: (scope: { pane: string; bot: string; teacher: string }, text: string, identity?: MailboxIdentity) => Promise<boolean> = async () => false) {
  const root = mkdtempSync(join(homedir(), "late-reports-"));
  const profile = join(root, "프로필");
  mkdirSync(profile);
  const bin = (await installOrbitMsg(join(root, ".orbit", "bin"), "win32", profile))!;
  const store = new Store(() => ({ instanceId: "ghost", model: "ghost" }));
  const bot = store.createBot();
  const pane = randomUUID();
  const secret = "a".repeat(64);
  let receipts = createMailboxReceipts(Promise.resolve(bootRowsNow().receipts));
  let pings = 0;
  let attention = 0;
  let arrived = 0;
  let loseReply = false;
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    try {
      const result = await receiveMailboxPost(req, {
        secret, store, receipts, origin: "test-device",
        label: async () => "LATE-REPORTS", auto,
        attention: async () => { attention++; }, reported() {}, refresh() {},
        notify() { pings++; }, arrived() { arrived++; },
      });
      if (loseReply) { loseReply = false; res.destroy(); return; }
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    } catch {
      res.writeHead(500).end();
    }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The fixture must bind TCP, not a named pipe.
  if (!address || typeof address === "string") throw new Error("missing port");
  const port = address.port;
  const url = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${mailboxGrant(secret, pane, bot.id, bot.id)}`, "x-orbit-pane": pane, "x-orbit-bot": bot.id, "x-orbit-teacher": bot.id, "content-type": "application/json" };
  writeFileSync(join(profile, "terminal-discovery.json"), JSON.stringify({ mailboxUrl: url }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, USERPROFILE: root, ORBIT_URL: url, ORBIT_MSG_AUTH: headers.authorization.slice(7), ORBIT_PANE: pane, ORBIT_BOT: bot.id, ORBIT_TEACHER: bot.id };
  delete env.ORBIT_REPORT_SIGNAL;
  const notes = () => store.activePath(bot.threadId).filter(message => message.kind === "note");
  return { root, profile, bin, server, port, url, env, headers, notes,
    counts: () => ({ pings, attention, arrived }),
    requests: () => requests,
    loseNextReply() { loseReply = true; },
    rebuild() { closeMessageDb(); receipts = createMailboxReceipts(Promise.resolve(bootRowsNow().receipts)); },
    post: (payload: TestReport) => fetch(`${url}/api/mailbox`, { method: "POST", headers, body: JSON.stringify(payload) }),
  };
}

it("defers an auto post before storage and stores a plain note if the watcher is unavailable", async () => {
  let available = true;
  const f = await fixture(async () => available);
  const payload = { text: "turn done", kind: "auto", messageId: randomUUID(), sentAt: Date.now() };
  expect(await (await f.post(payload)).json()).toEqual({ ok: true, deferred: true });
  expect(f.notes()).toHaveLength(0);
  expect(f.counts()).toEqual({ pings: 0, attention: 0, arrived: 0 });
  available = false;
  expect((await f.post({ ...payload, messageId: randomUUID() })).status).toBe(200);
  expect(f.notes()).toHaveLength(1);
  expect(f.notes()[0]!.text).not.toContain("REPORT:");
  expect(f.counts()).toEqual({ pings: 1, attention: 1, arrived: 1 });
});

it("keeps a deferred identity through watcher delivery, lost replies and a database restart", async () => {
  let identity: MailboxIdentity | undefined;
  const f = await fixture(async (_scope, _text, original) => { identity = original; return true; });
  const payload = { text: "turn done", kind: "auto", messageId: randomUUID(), sentAt: Date.now(), queued: true as const };
  expect(await (await f.post(payload)).json()).toEqual({ ok: true, deferred: true });
  expect(identity).toEqual({ messageId: payload.messageId, sentAt: payload.sentAt, queued: true });
  expect(f.notes()).toHaveLength(0);
  f.loseNextReply();
  await expect(f.post({ text: payload.text, ...identity })).rejects.toThrow();
  const delivered = reply.parse(await (await f.post({ text: payload.text, ...identity })).json());
  f.rebuild();
  expect(reply.parse(await (await f.post(payload)).json())).toEqual(delivered);
  expect(reply.parse(await (await f.post({ text: payload.text, ...identity })).json())).toEqual(delivered);
  expect(f.notes()).toHaveLength(1);
  expect(f.notes()[0]!.text).toMatch(/\(sent \d\d:\d\d while Wink was closed\)$/);
  expect(f.counts()).toEqual({ pings: 1, attention: 1, arrived: 1 });
});

function run(bin: string, env: NodeJS.ProcessEnv, form = "ps1", text = "finished") {
  const file = join(bin, `orbit-msg${form === "sh" ? "" : `.${form}`}`);
  const exe = form === "cmd" ? "cmd.exe" : form === "sh" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "powershell.exe";
  const args = form === "cmd" ? ["/d", "/q"]
    : form === "sh" ? [file, "--report", "DONE", "LATE-REPORTS", text]
      : ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, "--report", "DONE", "LATE-REPORTS", text];
  return new Promise<{ code: number | string; stdout: string; stderr: string }>(resolve => {
    const child = execFile(exe, args, { env, cwd: env.HOME, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    child.stdin!.end(form === "cmd" ? `call "${file}" --report DONE LATE-REPORTS ${text}\r\nexit %errorlevel%\r\n` : undefined);
  });
}

it.skipIf(process.platform !== "win32")("links a cut local report to its full text and keeps only the newest 100", async () => {
  const f = await fixture();
  const text = "보고서 report line\n".repeat(1000);
  const file = join(f.root, "report.txt");
  writeFileSync(file, text, "utf8");
  const reports = join(f.profile, "mailbox-reports", f.env.ORBIT_BOT!);
  mkdirSync(reports, { recursive: true });
  for (let i = 0; i < 100; i++) writeFileSync(join(reports, `${String(i).padStart(19, "0")}-00000000-0000-0000-0000-000000000000.txt`), "old");
  const result = await new Promise<{ code: number | string; stderr: string }>(resolve => {
    const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(f.bin, "orbit-msg.ps1"), "--report", "DONE", "LATE-REPORTS", "--file", file], { env: f.env, cwd: f.root, windowsHide: true }, (error, _stdout, stderr) => resolve({ code: error?.code ?? 0, stderr }));
    child.stdin!.end();
  });
  expect(result.code, result.stderr).toBe(0);
  const note = f.notes()[0]!.text!;
  const reportPath = note.split("\n").at(-1)!.replace(/^Full report: /, "");
  expect(reportPath.toLowerCase()).toMatch(/^\w:\\/);
  expect(realpathSync.native(join(reportPath, "..")).toLowerCase()).toBe(realpathSync.native(reports).toLowerCase());
  expect(readFileSync(reportPath, "utf8")).toBe(text);
  expect(readdirSync(reports)).toHaveLength(100);
  expect(readdirSync(reports)).not.toContain("0000000000000000000-00000000-0000-0000-0000-000000000000.txt");
}, 30_000);

it.skipIf(process.platform !== "win32")("leaves remote reports truncated without a local file", async () => {
  const f = await fixture();
  const file = join(f.root, "remote.txt");
  writeFileSync(file, "x".repeat(9000));
  const result = await new Promise<number | string>(resolve => {
    const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(f.bin, "orbit-msg.ps1"), "--report", "FAIL", "REMOTE", "--file", file], { env: { ...f.env, ORBIT_URL: f.url.replace("127.0.0.1", "localhost") }, cwd: f.root, windowsHide: true }, error => resolve(error?.code ?? 0));
    child.stdin!.end();
  });
  expect(result).toBe(0);
  expect(f.notes()[0]!.text).toMatch(/\[truncated\]$/);
  expect(() => readdirSync(join(f.profile, "mailbox-reports"))).toThrow();
}, 30_000);

it("keeps the full report path last when delivering a queued note", async () => {
  const f = await fixture();
  const path = "C:\\orbit\\report.txt";
  const response = await f.post({ text: `DONE TEST branch=x sha=y dirty=no\npartial\n[truncated]\nFull report: ${path}`, kind: "report", messageId: randomUUID(), sentAt: Date.now(), queued: true });
  expect(response.status).toBe(200);
  expect(f.notes()[0]!.text).toMatch(/\(sent \d\d:\d\d while Wink was closed\)\n\[truncated\]\nFull report: C:\\orbit\\report\.txt$/);
});

it("deduplicates a lost reply, concurrent retries and a database restart", async () => {
  const f = await fixture();
  const payload = { text: "DONE LATE branch=test sha=test dirty=no\nfinished", kind: "report", messageId: randomUUID(), sentAt: Date.now() };
  const replies = await Promise.all(Array.from({ length: 5 }, () => f.post(payload)));
  const ids = await Promise.all(replies.map(async response => {
    expect(response.status).toBe(200);
    return reply.parse(await response.json()).id;
  }));
  expect(new Set(ids).size).toBe(1);
  expect(f.notes()).toHaveLength(1);
  expect(f.counts()).toEqual({ pings: 1, attention: 1, arrived: 1 });
  f.rebuild();
  expect(reply.parse(await (await f.post(payload)).json()).id).toBe(ids[0]);
  expect(f.notes()).toHaveLength(1);
  expect(f.counts()).toEqual({ pings: 1, attention: 1, arrived: 1 });
  expect((await f.post({ ...payload, messageId: randomUUID() })).status).toBe(200);
  expect(f.notes()).toHaveLength(2);
});

it.skipIf(process.platform !== "win32").each(["ps1", "cmd", "sh"])("%s queues after 45 seconds and drains once with the previous release's pane env", async form => {
  const f = await fixture();
  await new Promise<void>(resolve => f.server.close(() => resolve()));
  const outbox = join(f.profile, "mailbox-outbox");
  if (form === "cmd") {
    mkdirSync(outbox);
    const now = Date.now();
    for (let index = 0; index < 500; index++) writeFileSync(join(outbox, `${now - index}-${randomUUID()}.json`), "{}");
    writeFileSync(join(outbox, `${now - 8 * 86_400_000}-${randomUUID()}.json`), "{}");
    writeFileSync(join(outbox, `${now}-${randomUUID()}.json.tmp`), "interrupted write");
  }
  const started = Date.now();
  const result = await run(f.bin, f.env, form);
  expect(result.code, result.stderr).toBe(0);
  expect(Date.now() - started).toBeGreaterThanOrEqual(45_000);
  expect(result.stdout).toContain("queued");
  const files = readdirSync(outbox).filter(file => file.endsWith(".json"));
  expect(files).toHaveLength(form === "cmd" ? 500 : 1);
  expect(readdirSync(outbox)).toHaveLength(files.length);
  expect(files.every(file => Number(file.split("-")[0]) > Date.now() - 7 * 86_400_000)).toBe(true);
  const queuedFile = files.find(file => JSON.parse(readFileSync(join(outbox, file), "utf8")).payload);
  expect(queuedFile).toBeDefined();
  const queued = JSON.parse(readFileSync(join(outbox, queuedFile!), "utf8"));
  expect(queued.payload.messageId).toMatch(/^[a-f0-9-]{36}$/);
  for (const file of files) if (file !== queuedFile) unlinkSync(join(outbox, file));
  await new Promise<void>(resolve => f.server.listen(f.port, "127.0.0.1", resolve));
  await Promise.all([deliverMailboxOutbox(f.profile, f.url), deliverMailboxOutbox(f.profile, f.url)]);
  expect(f.notes()).toHaveLength(1);
  expect(f.notes()[0]!.text).toMatch(/\(sent \d\d:\d\d while Wink was closed\)$/);
  expect(readdirSync(join(f.profile, "mailbox-outbox")).filter(file => file.endsWith(".json"))).toEqual([]);
  await deliverMailboxOutbox(f.profile, f.url);
  expect(f.notes()).toHaveLength(1);
}, 90_000);

it.skipIf(process.platform !== "win32")("concurrent senders keep both new reports within the 500-file cap", async () => {
  const f = await fixture();
  await new Promise<void>(resolve => f.server.close(() => resolve()));
  const outbox = join(f.profile, "mailbox-outbox");
  mkdirSync(outbox);
  const now = Date.now();
  for (let index = 0; index < 499; index++) writeFileSync(join(outbox, `${now - index}-${randomUUID()}.json`), "{}");
  const results = await Promise.all([run(f.bin, f.env, "ps1", "first"), run(f.bin, f.env, "ps1", "second")]);
  expect(results.map(result => result.code)).toEqual([0, 0]);
  expect(results.every(result => result.stdout.includes("queued"))).toBe(true);
  const files = readdirSync(outbox);
  expect(files).toHaveLength(500);
  const queued = files.map(file => ({ file, entry: JSON.parse(readFileSync(join(outbox, file), "utf8")) })).filter(item => item.entry.payload);
  expect(queued).toHaveLength(2);
  expect(new Set(queued.map(item => item.entry.payload.messageId)).size).toBe(2);
  for (const file of files) if (!queued.some(item => item.file === file)) unlinkSync(join(outbox, file));
  await new Promise<void>(resolve => f.server.listen(f.port, "127.0.0.1", resolve));
  await deliverMailboxOutbox(f.profile, f.url);
  expect(f.notes()).toHaveLength(2);
  expect(readdirSync(outbox)).toEqual([]);
}, 90_000);

it.skipIf(process.platform !== "win32")("a remote-pane URL retries across a real 30 second gap without a local queue", async () => {
  const f = await fixture();
  await new Promise<void>(resolve => f.server.close(() => resolve()));
  const started = Date.now();
  let lateRetry!: () => void;
  const gapCrossed = new Promise<void>(resolve => { lateRetry = resolve; });
  const down = createServer((_req, res) => {
    res.writeHead(503, { connection: "close" }).end();
    if (Date.now() - started >= 30_000) lateRetry();
  });
  servers.push(down);
  await new Promise<void>(resolve => down.listen(f.port, "127.0.0.1", resolve));
  const sending = run(f.bin, { ...f.env, ORBIT_URL: `http://localhost:${f.port}` });
  await gapCrossed;
  await new Promise<void>(resolve => { down.close(() => resolve()); down.closeAllConnections(); });
  await new Promise<void>(resolve => f.server.listen(f.port, "127.0.0.1", resolve));
  expect((await sending).code).toBe(0);
  expect(f.notes()).toHaveLength(1);
  expect(readdirSync(f.profile)).not.toContain("mailbox-outbox");
}, 60_000);

it("keeps previous-release text-only clients and rejects invalid identities before side effects", async () => {
  const f = await fixture();
  expect((await f.post({ text: "old pane" })).status).toBe(200);
  expect((await f.post({ text: "bad", messageId: "../escape" })).status).toBe(400);
  expect((await fetch(`${f.url}/api/mailbox`, { method: "POST", body: "not JSON" })).status).toBe(401);
  expect(f.notes()).toHaveLength(1);
});

it.skipIf(process.platform !== "win32")("uses the refreshed profile port only after the old pane URL fails", async () => {
  const f = await fixture();
  writeFileSync(join(f.profile, "terminal-discovery.json"), JSON.stringify({ mailboxUrl: f.url }));
  expect((await run(f.bin, { ...f.env, ORBIT_URL: "http://127.0.0.1:1" })).code).toBe(0);
  expect(f.notes()).toHaveLength(1);
});

it.skipIf(process.platform !== "win32")("rereads discovery when the app publishes a new port during retry", async () => {
  const f = await fixture();
  let requests = 0;
  const stale = createServer((_req, res) => { requests++; res.writeHead(503).end(); });
  servers.push(stale);
  await new Promise<void>(resolve => stale.listen(0, "127.0.0.1", resolve));
  const address = z.object({ port: z.number() }).parse(stale.address());
  const oldUrl = `http://127.0.0.1:${address.port}`;
  writeFileSync(join(f.profile, "terminal-discovery.json"), JSON.stringify({ mailboxUrl: oldUrl }));
  const sending = run(f.bin, { ...f.env, ORBIT_URL: oldUrl });
  while (requests < 2) await new Promise(resolve => setTimeout(resolve, 50));
  writeFileSync(join(f.profile, "terminal-discovery.json"), JSON.stringify({ mailboxUrl: f.url }));
  expect((await sending).code).toBe(0);
  expect(f.notes()).toHaveLength(1);
}, 65_000);

it("lets the notification hook finish the 45 second retry and queue write", () => {
  const settings = JSON.parse(orbitBinFiles("C:/throwaway/bin").find(([name]) => name === "claude-worker.json")![1]);
  expect(settings.hooks.Notification[0].hooks[0].timeout).toBeGreaterThanOrEqual(60);
});

it.skipIf(process.platform !== "win32")("the real shim retries a lost HTTP reply with the same ID", async () => {
  const f = await fixture();
  f.loseNextReply();
  expect((await run(f.bin, f.env)).code).toBe(0);
  expect(f.notes()).toHaveLength(1);
  expect(f.counts()).toEqual({ pings: 1, attention: 1, arrived: 1 });
});

it.skipIf(process.platform !== "win32").each(["ps1", "cmd", "sh"])("%s succeeds with one request and no outbox access", async form => {
  const f = await fixture();
  expect((await run(f.bin, f.env, form)).code).toBe(0);
  expect(f.notes()).toHaveLength(1);
  expect(f.counts()).toEqual({ pings: 1, attention: 1, arrived: 1 });
  expect(f.requests()).toBe(1);
  expect(readdirSync(f.profile).sort()).toEqual(["terminal-discovery.json"]);
});
