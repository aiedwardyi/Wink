import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Accounts } from "../relay/src/accounts.ts";
import { PHONE_RELAY_OFF, signTicket } from "../shared/relay-protocol.ts";
import { reportOwnerHash, reportPayload, type TeamReport } from "../shared/team-report.ts";
import { loadOrCreateIdentity, writeTicket } from "./phone-relay/store.ts";
import type { Message, Store } from "./store.ts";

const root = process.env.TEAM_REPORT_FIX_ROOT ?? process.cwd();
const source = (file: string) => import(pathToFileURL(join(root, file)).href);
const { TeamReports } = await source("server/team-reports.ts") as typeof import("./team-reports.ts");
const { collectReport } = await source("server/team-report-evidence.ts") as typeof import("./team-report-evidence.ts");
const { sendTeamReport } = await source("server/team-report-transport.ts") as typeof import("./team-report-transport.ts");
const { claimTeamReports } = await source("server/team-report-owner.ts") as typeof import("./team-report-owner.ts");
const { ReportStore } = await source("relay/src/reports.ts") as typeof import("../relay/src/reports.ts");
const { reportHttp } = await source("relay/src/reports-http.ts") as typeof import("../relay/src/reports-http.ts");
const ownerEmail = "edward@example.test", owner = reportOwnerHash(ownerEmail);
const current = { engine: "fixture", model: "fixture", version: "fixture" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGNcAAAAASUVORK5CYII=", "base64");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "report-fix-"));
  const path: Message[] = [];
  const bot = { id: "helper", name: "Helper", threadId: "thread" };
  const append = (role: "user" | "bot", text: string, extra: Partial<Message> = {}) => {
    const message = { id: `m${path.length}`, at: path.length + 1, role, kind: "text" as const, text, ...extra };
    path.push(message);
    return message;
  };
  let enrolled = true;
  const relay = new ReportStore(dir, ownerEmail);
  const identity = loadOrCreateIdentity(dir);
  const epoch = Math.floor(Date.now() / 1000);
  writeTicket(dir, signTicket({ label: identity.label, pk: identity.pk, iat: epoch, exp: epoch + 3600 }, generateKeyPairSync("ed25519").privateKey));
  const token = `e30.${Buffer.from(JSON.stringify({ iat: epoch, exp: epoch + 3600 })).toString("base64url")}.fixture`;
  const tokens = { idToken: () => token, freshIdToken: async () => token };
  const register = async () => ({ ok: true as const, label: identity.label, subHash: "subject", account: "unused" });
  const accounts = { register, owner: async () => ({ ok: true, subHash: "owner" }) } as unknown as Accounts;
  let failure: number | "offline" | "after-submit" | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (failure === "offline") throw new Error("offline");
    if (typeof failure === "number") return new Response(JSON.stringify({ error: "fixture-refusal" }), { status: failure });
    const req = Readable.from(init?.body ? [Buffer.from(String(init.body))] : []) as IncomingMessage;
    req.method = init?.method; req.url = new URL(String(url)).pathname;
    req.headers = Object.fromEntries(new Headers(init?.headers));
    let code = 0, output = "";
    const res = { writeHead: (status: number) => { code = status; }, end: (data: string) => { output = data; } } as unknown as ServerResponse;
    await reportHttp(req, res, { accounts, reports: relay, owner: ownerEmail, now: Date.now, who: () => ({ name: "QA laptop", person: "Minji" }) });
    if (failure === "after-submit") throw new Error("lost receipt");
    return new Response(output, { status: code });
  }) as typeof fetch;
  const store = { bot: (id: string) => ({ ...bot, id }), conversationForBot: (_id: string, thread: string) => thread === bot.threadId ? { bot } : undefined, activePath: () => path } as unknown as Store;
  const service = new TeamReports({ dir: join(dir, "drafts"), store, status: () => ({ ...PHONE_RELAY_OFF, state: "connected", reportOwner: owner }), enrolled: () => enrolled, owner,
    attachmentsDir: dir, roots: () => [], current: () => current, send: (report) => sendTeamReport({ dataDir: dir, base: () => "team.example", tokens, fetchImpl }, report) });
  const call = (args: Record<string, unknown>) => service.handle({ fromBotId: bot.id, fromThreadId: bot.threadId, ...args });
  const evidence = (request: Message, extra = {}) => collectReport({ owner, bot, threadId: bot.threadId, path, request, attachmentsDir: dir, roots: [], current, ...extra });
  const envelope = (report: TeamReport) => {
    const auth = { idToken: "token", ticket: "ticket", pk: identity.pk, sig: "A".repeat(86) };
    return { auth, report, signature: sign(null, reportPayload(owner, auth, report), identity.privateKey).toString("base64url") };
  };
  return { dir, path, bot, append, relay, service, call, evidence, envelope, register, tokens, fetchImpl, fail: (value: typeof failure) => { failure = value; }, enroll: (value: boolean) => { enrolled = value; } };
}

describe("review report authorization regressions", () => {
  it.each([false, true])("collects an attached recurring failure with a stale explicit ID: %s", async (explicit) => {
    const f = fixture(); f.append("user", "Keep notes"); f.append("bot", "Deleted notes"); f.append("user", "에디에게 보내");
    const draft = await f.call({ action: "draft" });
    f.append("bot", "Here is the report draft");
    const request = f.append("user", "The export failed again. 에디에게 보내", { png: png.toString("base64") });
    const result = await f.call({ action: "send", ...(explicit ? { report_id: draft.id } : {}) });
    expect(result).toMatchObject({ state: "accepted" });
    expect(result.id).not.toBe(draft.id);
    const [held] = await f.relay.claim();
    expect(held.report.requestMessageId).toBe(request.id);
    expect(held.report.images).toEqual([expect.objectContaining({ messageId: request.id })]);
  });
  it.each(['<attached-image path="C:/fixture/incident.png" />', '<attached-file path="C:/fixture/log.txt" />'])("starts a fresh report for the call phrase with %s", async (attachment) => {
    const f = fixture(); f.append("user", "Keep notes"); f.append("bot", "Deleted notes"); f.append("user", "에디에게 보내");
    f.fail("after-submit"); const first = await f.call({ action: "send" }); f.fail(undefined);
    const request = f.append("user", `에디에게 보내 ${attachment}`);
    const sent = await f.call({ action: "send", report_id: first.id });
    expect(sent.state).toBe("accepted"); expect(sent.id).not.toBe(first.id);
    expect(JSON.parse(readFileSync(join(f.dir, "drafts", `${sent.id}.json`), "utf8")).report.requestMessageId).toBe(request.id);
  });
  it.each(["send", "retry"])("keeps the explicit report ID on %s after unrelated chat", async (action) => {
    const f = fixture(); f.append("user", "Keep the export running"); const bad = f.append("bot", "Stopped the export");
    const request = f.append("user", "에디에게 보내"); const draft = await f.call({ action: "draft" });
    const original = draft.report as TeamReport;
    f.append("bot", "Here is the report draft"); f.append("user", "What is two plus two?"); f.append("bot", "Four");
    f.append("user", "에디에게 보내");
    expect(await f.call({ action, report_id: draft.id })).toMatchObject({ id: draft.id, state: "accepted" });
    const [held] = await f.relay.claim();
    expect(held.report).toEqual(original);
    expect(held.report).toMatchObject({ selectedMessageId: bad.id, requestMessageId: request.id });
  });
  it.each(["send", "retry"])("validates an explicit report branch on %s after unrelated chat", async (action) => {
    const f = fixture(); f.append("user", "Keep notes"); const bad = f.append("bot", "Deleted notes");
    f.append("user", "에디에게 보내"); const draft = await f.call({ action: "draft" });
    f.append("user", "What is two plus two?"); f.append("bot", "Four"); f.append("user", "에디에게 보내");
    f.path.splice(f.path.indexOf(bad), 1);
    expect(await f.call({ action, report_id: draft.id })).toEqual({ error: "Saved report does not belong to this branch/sender/team." });
    expect(await f.relay.claim()).toHaveLength(0);
  });
  it.each(["collect", "send"].flatMap((action) => ["earlier", "selected"].map((change) => [action, change])))("R6 applies %s evidence updates to a saved draft: %s", async (action, change) => {
    const f = fixture(); const correction = f.append("user", "Keep the export running");
    f.append("user", "Check status"); const bad = f.append("bot", "Stopped the export");
    f.append("user", "Why?"); const recent = f.append("bot", "Sorry"); f.append("user", "에디에게 보내");
    const draft = await f.call({ action: "collect", summary: "Export stopped", diagnosis: "Cause unknown" });
    expect((draft.report as TeamReport).selectedMessageId).toBe(recent.id);
    expect((draft.report as TeamReport).originals.some((message) => message.id === correction.id)).toBe(false);
    const updated = await f.call({ action, report_id: draft.id, ...(change === "earlier" ? { earlier_message_ids: [correction.id] } : { selected_message_id: bad.id }) });
    expect(updated).toMatchObject({ id: draft.id, state: action === "send" ? "accepted" : "draft" });
    const saved = JSON.parse(readFileSync(join(f.dir, "drafts", `${draft.id}.json`), "utf8")).report as TeamReport;
    expect(saved).toMatchObject({ summary: "Export stopped", diagnosis: "Cause unknown", selectedMessageId: change === "selected" ? bad.id : recent.id });
    if (change === "earlier") expect(saved.originals.find((message) => message.id === correction.id)?.text).toBe(correction.text);
    if (action === "collect") expect(await f.call({ action: "send", report_id: draft.id })).toMatchObject({ id: draft.id, state: "accepted" });
    expect((await f.relay.claim())[0].report).toEqual(saved);
  });
  it("R6 retains earlier bot references and excluded images when correcting a draft selection", async () => {
    const f = fixture(); const earlier = f.append("bot", "The export must keep running", { png: png.toString("base64") });
    f.append("user", "Check status"); const bad = f.append("bot", "Stopped the export");
    f.append("user", "Why?"); f.append("bot", "Sorry"); f.append("user", "에디에게 보내");
    const draft = await f.call({ action: "collect", earlier_message_ids: [earlier.id], exclude_image_message_ids: [earlier.id] });
    const updated = await f.call({ action: "collect", report_id: draft.id, selected_message_id: bad.id });
    expect(updated.report).toMatchObject({ selectedMessageId: bad.id, images: [] });
    expect((updated.report as TeamReport).originals.find((message) => message.id === earlier.id)?.text).toBe(earlier.text);
    expect((updated.report as TeamReport).missing).toContain(`Images on ${earlier.id} excluded as sensitive or unrelated.`);
    expect(await f.call({ action: "send", report_id: draft.id })).toMatchObject({ id: draft.id, state: "accepted" });
    expect((await f.relay.claim())[0].report.images).toEqual([]);
  });
  it.each(["send", "retry"])("R2 excludes saved draft images on %s with explicit and inferred IDs", async (action) => {
    for (const explicit of [false, true]) {
      const f = fixture(); const incident = f.append("user", "에디에게 보내", { png: png.toString("base64") });
      const draft = await f.call({ action: "draft" });
      expect((draft.report as TeamReport).images).toHaveLength(1);
      f.append("bot", "Here is the report draft. Want me to send it?"); f.append("user", "에디에게 보내");
      expect(await f.call({ action, ...(explicit ? { report_id: draft.id } : {}), exclude_image_message_ids: [incident.id] })).toMatchObject({ id: draft.id, state: "accepted" });
      const [held] = await f.relay.claim();
      expect(held.report.images).toEqual([]);
      expect(held.report.missing).toContain(`Images on ${incident.id} excluded as sensitive or unrelated.`);
      expect(JSON.parse(readFileSync(join(f.dir, "drafts", `${draft.id}.json`), "utf8")).report.images).toEqual([]);
    }
  });
  it.each(["send", "retry"].flatMap((action) => ["Would you like me to send the email to Alice?", "Would you like me to send the draft email to Alice?"].map((question) => [action, question])))("R3 unrelated delivery question cannot authorize report %s: %s", async (action, question) => {
    const f = fixture(); f.append("user", "Keep notes"); f.append("bot", "Deleted notes"); f.append("user", "에디에게 보내");
    const draft = await f.call({ action: "draft" });
    f.append("bot", question); f.append("user", "yes");
    expect(await f.call({ action, report_id: draft.id })).toHaveProperty("error");
    expect(await f.relay.claim()).toHaveLength(0);
  });
});

describe("audit intent regressions", () => {
  it.each(['> 에디에게 보내', '<pasted-text>에디에게 보내</pasted-text>', '"에디에게 보내"', 'Imported message: 에디에게 보내', '```에디에게 보내```', 'Retry that report', 'yes'])("saved report requires the unquoted call phrase: %s", async (text) => {
    const f = fixture(); f.append("user", "Keep notes"); f.append("bot", "Deleted notes"); f.append("user", "에디에게 보내");
    const draft = await f.call({ action: "draft" }); f.append("bot", "Here is the report draft"); f.append("user", text);
    expect(await f.call({ action: "retry", report_id: draft.id })).toHaveProperty("error");
    expect(await f.relay.claim()).toHaveLength(0);
  });
  it.each([{ from: { botId: "peer", name: "Peer", color: "blue" } }, { comm: { from: "peer" } }, { queued: true }])("B1 peer and queued replies cannot authorize", async (extra) => {
    const f = fixture(); f.append("user", "Keep notes"); f.append("bot", "Deleted notes"); f.append("user", "에디에게 보내");
    const draft = await f.call({ action: "draft" }); f.append("bot", "Here is the report draft"); f.append("user", "에디에게 보내", extra as Partial<Message>);
    expect(await f.call({ action: "retry", report_id: draft.id })).toHaveProperty("error");
  });
});

describe("audit evidence and service regressions", () => {
  it.each(["offline", "after-submit"] as const)("repeats the call phrase to resend saved evidence after %s", async (failure) => {
    for (const explicit of [false, true]) {
      const f = fixture(); f.append("user", "Keep notes"); f.append("bot", "Deleted notes"); f.append("user", "에디에게 보내");
      f.fail(failure); const first = await f.call({ action: "send" }); f.fail(undefined);
      const saved = JSON.parse(readFileSync(join(f.dir, "drafts", `${first.id}.json`), "utf8")).report;
      f.append("user", "에디 에게 보네줘");
      expect(await f.call({ action: "send", ...(explicit ? { report_id: first.id } : {}) })).toMatchObject({ id: first.id, state: "accepted" });
      expect((await f.relay.claim())[0].report).toEqual(saved);
      expect(readdirSync(join(f.dir, "team-reports"))).toHaveLength(1);
    }
  });
  it("collects a new incident when the call phrase follows a confirmed send", async () => {
    const f = fixture(); f.append("user", "Keep notes"); f.append("bot", "Deleted notes"); f.append("user", "에디에게 보내");
    const first = await f.call({ action: "send" }); f.append("bot", "Report accepted"); f.append("user", "에디에게 보내");
    expect(await f.call({ action: "retry" })).toMatchObject({ id: first.id, state: "accepted" });
    const sent = await f.call({ action: "send" });
    expect(sent.state).toBe("accepted"); expect(sent.id).not.toBe(first.id);
  });
  it("B2 defaults to the reply target, exposes answer IDs and records the default", async () => {
    const f = fixture(); f.append("user", "Use 700"); const bad = f.append("bot", "Used 400"); f.append("user", "Why?"); f.append("bot", "Sorry");
    f.append("user", "에디에게 보내", { replyToId: bad.id });
    const result = await f.call({ action: "collect" });
    expect(result.report).toMatchObject({ selectedMessageId: bad.id });
    expect(result.recentAnswers).toEqual(expect.arrayContaining([expect.objectContaining({ id: bad.id })]));
    expect((result.report as TeamReport).missing.join(" ")).toContain("defaulted");
  });
  it("B2 resends the saved incident without an ID after a lost receipt", async () => {
    const f = fixture(); f.append("user", "Use staging"); const bad = f.append("bot", "Used production"); f.append("user", "에디에게 보내");
    f.fail("after-submit"); const first = await f.call({ action: "send" }); f.fail(undefined);
    f.append("bot", `Could not confirm delivery. Private draft ${first.id}.`); f.append("user", "에디에게 보내");
    const retry = await f.call({ action: "send" });
    expect(retry).toMatchObject({ id: first.id, state: "accepted" });
    expect((await f.relay.claim())[0].report.selectedMessageId).toBe(bad.id);
    expect(readdirSync(join(f.dir, "team-reports"))).toHaveLength(1);
  });
  it.each([false, true])("B3 request screenshot is the incident, busy chat %s", async (busy) => {
    const f = fixture(); if (busy) { f.append("user", "Private hiring plan"); f.append("bot", "Hire two people"); }
    const request = f.append("user", "에디에게 보내", { png: png.toString("base64") });
    const sent = await f.call({ action: "send" }); expect(sent.state).toBe("accepted");
    const [held] = await f.relay.claim(); expect(held.report.selectedMessageId).toBe(request.id);
    expect(held.report.originals.map((m) => m.id)).toEqual([request.id]);
    expect(Buffer.from(held.report.images[0].base64, "base64")).toEqual(png);
  });
  it("B3 attached file request can be selected explicitly", () => {
    const f = fixture(); const request = f.append("user", '에디에게 보내 <attached-file path="C:/fixture/log.txt" />');
    expect(f.evidence(request, { selectedMessageId: request.id }).selectedMessageId).toBe(request.id);
  });
  it("B1 a short approval cannot act after unrelated chat or on an abandoned branch", async () => {
    const f = fixture(); f.append("user", "Keep notes"); f.append("bot", "Deleted notes"); f.append("user", "에디에게 보내");
    const draft = await f.call({ action: "draft" }); f.append("bot", "Would you like a weather forecast?"); f.append("user", "yes");
    expect(await f.call({ action: "retry", report_id: draft.id })).toHaveProperty("error");
    f.path.splice(2, 1); f.append("bot", "Here is the report draft"); f.append("user", "yes");
    expect(await f.call({ action: "retry", report_id: draft.id })).toHaveProperty("error");
    expect(await f.relay.claim()).toHaveLength(0);
  });
  it("N2 reserves selected answer and request before large earlier references", () => {
    const f = fixture(); const earlier = Array.from({ length: 4 }, () => f.append("user", "E".repeat(13_000)));
    const bad = f.append("bot", "Closed the ticket incorrectly"); const request = f.append("user", "에디에게 보내");
    const report = f.evidence(request, { earlierMessageIds: earlier.slice(0, 3).map((m) => m.id) });
    expect(report.originals.find((m) => m.id === bad.id)?.text).toBe(bad.text);
    expect(report.originals.find((m) => m.id === request.id)?.text).toBe(request.text);
    expect(report.originals.map((m) => m.id)).toEqual(f.path.map((m) => m.id));
    expect(report.originals.reduce((n, m) => n + Buffer.byteLength(m.text), 0)).toBeLessThanOrEqual(48_000);
  });
  it("N3 group members derive one incident ID and create one relay report", async () => {
    const f = fixture(); f.append("user", "Keep export running"); const bad = f.append("bot", "Stopped export"); const request = f.append("user", "에디에게 보내");
    expect(f.evidence(request).id).toBe(f.evidence(request, { bot: { id: "peer", name: "Peer" } }).id);
    await f.call({ action: "send", selected_message_id: bad.id });
    await f.service.handle({ fromBotId: "peer", fromThreadId: "thread", action: "send", selected_message_id: bad.id });
    expect(readdirSync(join(f.dir, "team-reports"))).toHaveLength(1);
  });
  it.each([400, 403, 409, 429, 507])("N1 reports definitive HTTP %s refusal", async (status) => {
    const f = fixture(); f.append("user", "Keep notes"); f.append("bot", "Deleted notes"); f.append("user", "에디에게 보내"); f.fail(status);
    const receipt = await f.call({ action: "send" });
    expect(receipt.text).toMatch(/refused, not delivered:.*fixture-refusal/i);
    expect(receipt.text).not.toMatch(/may have accepted/);
  });
  it("N1 masked PEM fields pass while raw nested secrets fail", async () => {
    const f = fixture(); f.append("user", "-----BEGIN OPENSSH PRIVATE KEY-----\nrawkeybytes\n-----END OPENSSH PRIVATE KEY-----"); f.append("bot", "Deleted known_hosts");
    const request = f.append("user", "에디에게 보내"); const report = f.evidence(request);
    expect((await f.relay.submit(f.envelope(report), { register: f.register }, Date.now())).status).toBe(200);
    const raw = { ...report, id: "a".repeat(32), originals: [{ ...report.originals[0], text: "password=FixtureSecret123" }] };
    expect((await f.relay.submit(f.envelope(raw), { register: f.register }, Date.now())).status).toBe(400);
  });
  it("N4 owner archive and note contain relay PC name and person", async () => {
    const f = fixture(); f.append("user", "Keep notes"); f.append("bot", "Deleted notes"); f.append("user", "에디에게 보내");
    const sent = await f.call({ action: "send" }); const notes: string[] = [];
    expect(await claimTeamReports({ dir: join(f.dir, "owner"), base: () => "team.example", baked: null, owner, email: () => ownerEmail, tokens: f.tokens, fetchImpl: f.fetchImpl, postedIds: () => new Set(), post: (text) => { notes.push(text); return true; } })).toBe(1);
    expect(notes[0]).toContain("QA laptop"); expect(notes[0]).toContain("Minji");
    expect(JSON.parse(readFileSync(join(f.dir, "owner", String(sent.id), "report.json"), "utf8")).pc).toMatchObject({ name: "QA laptop", person: "Minji" });
  });
  it("B5 official non-member registers zero reporting tool bytes under the rule's gate", async () => {
    const f = fixture(); f.enroll(false); expect(f.service.prompt()).toBe("");
    const index = readFileSync(join(root, "server/index.ts"), "utf8");
    expect(/OMB_TEAM_REPORTS:\s*teamReports\.prompt\(\)\s*\?\s*"1"\s*:\s*"0"/.test(index)).toBe(true);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OMB_|ORBIT_)/.test(key)));
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, "server/drivers/agents-proxy.ts")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...env, OMB_BOT_ID: "helper", OMB_THREAD_ID: "thread", OMB_COMMS_TOKEN: "fixture", OMB_TEAM_REPORTS: f.service.prompt() ? "1" : "0" } });
      let text = ""; const timer = setTimeout(() => { child.kill(); reject(new Error("proxy timeout")); }, 5000);
      child.on("error", reject); child.stdout.on("data", (chunk) => { text += chunk; if (text.includes("\n")) { clearTimeout(timer); child.stdin.end(); resolve(text.split("\n")[0]); } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    });
    expect(JSON.parse(output).result.tools.filter((tool: { name: string }) => tool.name === "report_issue")).toEqual([]);
  });
});

describe("audit relay retention regressions", () => {
  it("B4 cycles 600 filed reports, preserves filed dedup and 409 binding after reopen", async () => {
    const f = fixture(); f.append("user", "Keep notes"); f.append("bot", "Deleted notes"); const request = f.append("user", "에디에게 보내");
    const base = f.evidence(request); const epoch = Date.now();
    for (let i = 0; i < 600; i++) {
      const report = { ...base, id: createHash("sha256").update(String(i)).digest("hex").slice(0, 32) };
      const now = epoch + i * 86_400_000;
      expect((await f.relay.submit(f.envelope(report), { register: f.register }, now)).status).toBe(200);
      await f.relay.ack([report.id], now);
      if (i === 0) expect(JSON.parse(readFileSync(join(f.dir, "team-reports", `${report.id}.json`), "utf8"))).not.toHaveProperty("report");
    }
    const entries = readdirSync(join(f.dir, "team-reports")).map((file) => readFileSync(join(f.dir, "team-reports", file), "utf8"));
    expect(entries.every((entry) => !entry.includes('"report":'))).toBe(true);
    expect(entries.reduce((n, entry) => n + Buffer.byteLength(entry), 0)).toBeLessThan(200_000);
    const first = { ...base, id: createHash("sha256").update("0").digest("hex").slice(0, 32) };
    const reopened = new ReportStore(f.dir, ownerEmail);
    expect((await reopened.submit(f.envelope(first), { register: f.register }, epoch + 601 * 86_400_000)).body).toMatchObject({ state: "filed" });
    const register = async () => ({ ...await f.register(), subHash: "another-subject" });
    expect((await reopened.submit(f.envelope(first), { register }, epoch + 601 * 86_400_000)).status).toBe(409);
  }, 60000);
  it("B4 expires unfiled payloads after fourteen days", async () => {
    const f = fixture(); f.append("user", "Keep notes"); f.append("bot", "Deleted notes"); const report = f.evidence(f.append("user", "에디에게 보내"));
    const now = Date.now(); expect((await f.relay.submit(f.envelope(report), { register: f.register }, now)).status).toBe(200);
    expect(await f.relay.claim(now + 14 * 86_400_000)).toHaveLength(0);
    expect(readdirSync(join(f.dir, "team-reports"))).toHaveLength(0);
  });
  it("B4 filing releases three large images and retains the daily sender cap", async () => {
    const f = fixture(); f.append("user", "Keep notes"); f.append("bot", "Deleted notes"); const base = f.evidence(f.append("user", "에디에게 보내"));
    const bytes = Buffer.concat([png, Buffer.alloc(1_048_000 - png.length)]);
    const image: TeamReport["images"][number] = { messageId: "m1", mime: "image/png", base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), source: "stored-message", collectedAt: 1 };
    for (let i = 0; i < 20; i++) {
      const report = { ...base, id: i.toString(16).padStart(32, "0"), images: [image, image, image] };
      expect((await f.relay.submit(f.envelope(report), { register: f.register }, Date.now())).status).toBe(200);
      await f.relay.ack([report.id]);
    }
    expect((await f.relay.submit(f.envelope(base), { register: f.register }, Date.now())).status).toBe(429);
  });
  it("B4 migrates old filed payloads to compact tombstones", async () => {
    const f = fixture(); f.append("user", "Keep notes"); f.append("bot", "Deleted notes"); const report = f.evidence(f.append("user", "에디에게 보내"));
    await f.relay.submit(f.envelope(report), { register: f.register }, Date.now());
    const file = join(f.dir, "team-reports", `${report.id}.json`);
    const held = JSON.parse(readFileSync(file, "utf8")); held.filed = true; writeFileSync(file, JSON.stringify(held));
    expect(await new ReportStore(f.dir, ownerEmail).claim()).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("report");
  });
});
