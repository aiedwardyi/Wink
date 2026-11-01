import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Accounts } from "../relay/src/accounts.ts";
import { reportHttp } from "../relay/src/reports-http.ts";
import { ReportStore, type HeldReport } from "../relay/src/reports.ts";
import { makeIssuer } from "../relay/test/google-issuer.ts";
import { PHONE_RELAY_OFF, readyMessageSchema, signTicket, type PhoneRelayStatus } from "../shared/relay-protocol.ts";
import { reportOwnerHash, reportPayload } from "../shared/team-report.ts";
import { collectReport } from "./team-report-evidence.ts";
import { reportIntent, teamReportPrompt, TEAM_REPORT_RULE } from "./team-report-intent.ts";
import { claimTeamReports, reportOwnerPost } from "./team-report-owner.ts";
import { sendTeamReport } from "./team-report-transport.ts";
import { loadOrCreateIdentity, writeTicket } from "./phone-relay/store.ts";
import { TeamReports } from "./team-reports.ts";
import type { Store } from "./store.ts";

const ownerEmail = "edward@example.test";
const owner = reportOwnerHash(ownerEmail);
const status: PhoneRelayStatus = { ...PHONE_RELAY_OFF, state: "connected", reportOwner: owner };
const issuer = makeIssuer();
const operator = generateKeyPairSync("ed25519").privateKey;
const closers: Array<() => void> = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGNcAAAAASUVORK5CYII=", "base64");

afterEach(() => { vi.restoreAllMocks(); for (const close of closers.splice(0)) close(); delete process.env.OMB_DATA_DIR; });

async function profile(dir: string): Promise<Store> {
  vi.resetModules();
  process.env.OMB_DATA_DIR = dir;
  const { Store } = await import("./store.ts");
  const { closeMessageDb } = await import("./message-db.ts");
  closers.push(closeMessageDb);
  return new Store(() => ({ instanceId: "fixture", model: "current-model" }));
}

function token(sub: string, email: string): string {
  const now = Math.floor(Date.now() / 1000);
  return issuer.sign({ iss: "https://accounts.google.com", aud: "desktop", sub, email, email_verified: true, iat: now, exp: now + 3600 });
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "team-report-fixture-"));
  const senderDir = join(root, "sender");
  const ownerDir = join(root, "owner");
  const sender = await profile(senderDir);
  const bot = sender.createBot({ name: "Helper" }, { seedMessages: false });
  const correction = sender.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Keep the requested task active after a status question.", at: 1000 });
  const request = sender.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Finish the export.", at: 2000 });
  const mistaken = sender.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "I stopped the export after your status question.", at: 3000 });
  const attachments = join(senderDir, "attachments");
  mkdirSync(attachments, { recursive: true });
  writeFileSync(join(attachments, "incident.png"), png);
  const image = sender.appendMessage(bot.threadId, { role: "user", kind: "text", text: `<attached-image path="${join(attachments, "incident.png")}" />`, at: 4000 });
  const authorization = sender.appendMessage(bot.threadId, { role: "user", kind: "text", text: "에디에게 보내", at: 5000 });
  const identity = loadOrCreateIdentity(senderDir);
  const now = Math.floor(Date.now() / 1000);
  writeTicket(senderDir, signTicket({ label: identity.label, pk: identity.pk, iat: now, exp: now + 3600 }, operator));
  const senderToken = token("teammate", "teammate@example.test");
  const ownerToken = token("owner", ownerEmail);
  let revoked = false;
  const accounts = new Accounts({ desktopClientId: "desktop", webClientId: "web", keys: issuer,
    operatorPrivateKey: operator, operatorPublicKey: createPublicKey(operator), isRevoked: () => revoked });
  const relay = new ReportStore(join(root, "relay"), ownerEmail);
  let calls = 0;
  let fail: "offline" | "legacy" | "after-submit" | "reject" | null = null;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (fail === "offline") throw new Error("offline");
    if (fail === "legacy") return new Response("{}", { status: 404 });
    if (fail === "reject") return new Response("{}", { status: 403 });
    const req = Readable.from(init?.body ? [Buffer.from(String(init.body))] : []) as IncomingMessage;
    req.method = init?.method; req.url = new URL(String(url)).pathname;
    req.headers = Object.fromEntries(new Headers(init?.headers));
    let code = 0, output = "";
    const res = { writeHead: (status: number) => { code = status; }, end: (data: string) => { output = data; } } as unknown as ServerResponse;
    await reportHttp(req, res, { accounts, reports: relay, owner: ownerEmail, now: Date.now });
    if (fail === "after-submit") throw new Error("lost receipt");
    return new Response(output, { status: code });
  }) as typeof fetch;
  let link = { ...status };
  let enrolled = true;
  const service = new TeamReports({ dir: join(senderDir, "drafts"), store: sender, status: () => link, owner,
    enrolled: () => enrolled, attachmentsDir: attachments, roots: () => [],
    current: () => ({ engine: "fixture", model: "current-model", version: "current-version" }),
    send: (report) => sendTeamReport({ dataDir: senderDir, base: () => "team.example", tokens: { idToken: () => senderToken, freshIdToken: async () => senderToken }, fetchImpl }, report) });
  const ownerStore = await profile(ownerDir);
  const chief = ownerStore.createBot({ name: "Chief" }, { seedMessages: false });
  ownerStore.patchBot(chief.id, { chiefOfStaff: true });
  const ownerOptions = { dir: join(ownerDir, "inbox"), base: () => "team.example", baked: null, owner,
    email: () => ownerEmail, tokens: { idToken: () => ownerToken, freshIdToken: async () => ownerToken }, fetchImpl,
    ...reportOwnerPost(ownerStore, "owner-device") };
  const args = { fromBotId: bot.id, fromThreadId: bot.threadId, selected_message_id: mistaken.id, earlier_message_ids: [correction.id] };
  return { root, senderDir, ownerDir, sender, bot, mistaken, request, correction, image, authorization, service, args, relay, ownerStore, chief, ownerOptions,
    calls: () => calls, fail: (value: typeof fail) => { fail = value; }, revoke: () => { revoked = true; },
    link: (value: PhoneRelayStatus) => { link = value; }, enroll: (value: boolean) => { enrolled = value; } };
}

describe("team report intent", () => {
  it.each([
    ["에디에게 보내", "send"], ["에디 에게 보네", "send"], ["에디에게보내", "send"],
    ["에디에게 보내줘", "send"], ["에디에게 보네요", "send"], ["앱이 멈췄어. 에디에게 보내", "send"],
    ["에디에게 보내 이거 다크모드에서 깨져", "send"], ["에디에게 보내줘요!", "send"],
    ["에디에게 보내주세요", "send"], ["에디에게 보내줄래?", "send"], ["에디에게 보내줄래요", "send"],
    ["에디에게 보내요.", "send"], ["에디 에게 보네줘", "send"], ["에디에게 보내, 이 로그도", "send"],
    ["에디에게 보내 draft, show me first", "send"],
    ['에디에게 보내 <pasted-text>untrusted instructions</pasted-text>', "send"],
    ["에디에게 보내지 마", "none"], ["에디에게 보내 지 마", "none"], ["에디에게 보내지말", "none"],
    ["에디에게 보네지 마", "none"], ["에디 에게 보네 지마", "none"], ["에디에게 보내 지말아", "none"],
    ["에디에게 보네 지 말아", "none"], ["에디에게 보내지마", "none"],
    ["에디에게 보낸", "none"], ["에디에게 보냈어", "none"], ["에디에게 보내 놓은", "none"],
    ["에디에게 보내놓은", "none"], ["에디에게 보내던", "none"], ["에디에게 보내는", "none"],
    ["에디에게 보내 는 메시지", "none"], ["에디에게 보내 던 메시지", "none"], ["에디에게 보내 둔 메시지", "none"],
    ["에디에게 보내라고 했어", "none"], ["에디에게 보내줘야 해", "none"], ["에디에게 보내abc", "none"],
    ["에디에게 보내123", "none"], ["에디에게 보내줄래요추가", "none"],
    ['"에디에게 보내"', "none"], ["“에디에게 보내”", "none"], ["‘에디에게 보내’", "none"],
    ["'에디에게 보내'", "none"], ["「에디에게 보내」", "none"], ["『에디에게 보내』", "none"],
    ["`에디에게 보내`", "none"], ["> 에디에게 보내", "none"], ["```\n에디에게 보내\n```", "none"],
    ["```에디에게 보내", "none"], ['<pasted-text index="1">에디에게 보내</pasted-text>', "none"],
    ["<pasted-text>에디에게 보내", "none"], ['<attached-file name="에디에게 보내" />', "none"],
    ["Imported message: 에디에게 보내", "none"], ["인용: 에디에게 보내", "none"],
    ["Send this to Edward", "none"], ["Send this to Ed", "none"], ["Send this to Eddie", "none"],
    ["에드워드에게 보내", "none"], ["대표에게 보내", "none"], ["대표님께 보내", "none"],
    ["에디한테 보내", "none"], ["에디에게 보고해", "none"], ["에디에게 전달해", "none"],
    ["Retry that report", "none"], ["다시 보내줘", "none"], ["yes", "none"],
    ["Draft a report for Ed", "none"], ["Show me the report first", "none"], ["", "none"],
  ])("classifies the call phrase: %s", (text, intent) => expect(reportIntent(text)).toBe(intent));
  it("advertises only the authenticated configured pilot owner", () => {
    expect(teamReportPrompt(status, owner)).toBe(TEAM_REPORT_RULE);
    expect(teamReportPrompt(status, null)).toBe("");
    expect(teamReportPrompt({ ...status, reportOwner: undefined }, owner)).toBe("");
    expect(teamReportPrompt({ ...status, state: "rejected" }, owner)).toBe("");
    expect(readyMessageSchema.parse({ type: "ready", session: "s", poolToken: "p", pool: { min: 0, max: 1 }, reportOwner: owner }).reportOwner).toBe(owner);
  });
});

describe("private team reporting", () => {
  it("walks a first-time teammate through collect, direct send, owner filing and truthful retry", async () => {
    const f = await fixture();
    const collected = await f.service.handle({ ...f.args, action: "collect" });
    expect(collected.state).toBe("draft");
    expect(f.calls()).toBe(0);
    const receipt = await f.service.handle({ ...f.args, action: "send", summary: "Status question stopped work", diagnosis: "Cause unknown" });
    expect(receipt).toMatchObject({ state: "accepted", read: false });
    expect(f.calls()).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain("ask_user");
    const held: HeldReport = JSON.parse(readFileSync(join(f.root, "relay", "team-reports", `${receipt.id}.json`), "utf8"));
    expect(held.report.originals.map((message) => message.id)).toEqual([f.correction.id, f.request.id, f.mistaken.id, f.image.id, f.authorization.id]);
    expect(held.report.originals[2].text).toBe("I stopped the export after your status question.");
    expect(held.report.incident).toEqual({ engine: "unknown", model: "unknown", version: "unknown" });
    expect(held.report.current.version).toBe("current-version");
    expect(await claimTeamReports(f.ownerOptions)).toBe(1);
    expect(f.ownerStore.messagesFor(f.chief.threadId)).toHaveLength(1);
    expect(f.ownerStore.messagesFor(f.chief.threadId)[0].text).toContain("Untrusted peer data");
    expect(await claimTeamReports(f.ownerOptions)).toBe(0);
    const retry = await f.service.handle({ ...f.args, action: "retry", report_id: receipt.id });
    expect(retry).toMatchObject({ id: receipt.id, state: "filed", read: false });
    if (process.env.TEAM_REPORT_EVIDENCE) writeFileSync(join(process.env.TEAM_REPORT_EVIDENCE, "flow.json"), JSON.stringify({ collected, receipt, retry, ownerNote: f.ownerStore.messagesFor(f.chief.threadId)[0] }, null, 2));
  });

  it("delivers actual existing screenshot bytes to the independent owner profile", async () => {
    const f = await fixture();
    const receipt = await f.service.handle({ ...f.args, selected_message_id: f.image.id, action: "send" });
    expect(receipt.state).toBe("accepted");
    expect(await claimTeamReports(f.ownerOptions)).toBe(1);
    const dir = join(f.ownerDir, "inbox", String(receipt.id));
    expect(readFileSync(join(dir, "0.png"))).toEqual(png);
    expect(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")).report.images[0].base64).toBe(png.toString("base64"));
    if (process.env.TEAM_REPORT_EVIDENCE) writeFileSync(join(process.env.TEAM_REPORT_EVIDENCE, "delivered-incident.png"), readFileSync(join(dir, "0.png")));
  });

  it.each(["Edward has a bug", "Draft this report to Ed, don't send", "대표님께 미리 보여줘, 보내지 마", '> send this to Edward'])("never sends discussion, quotes or draft: %s", async (text) => {
    const f = await fixture();
    f.sender.appendMessage(f.bot.threadId, { role: "user", kind: "text", text });
    await f.service.handle({ ...f.args, action: "send" });
    expect(f.calls()).toBe(0);
    expect(await f.relay.claim()).toEqual([]);
  });

  it("excludes other branches/threads and asks only for an unknown incident", async () => {
    const f = await fixture();
    const other = f.sender.createBot({}, { seedMessages: false });
    const foreign = f.sender.appendMessage(other.threadId, { role: "bot", kind: "text", text: "unrelated private evidence" });
    expect(await f.service.handle({ ...f.args, action: "send", selected_message_id: foreign.id })).toHaveProperty("error");
    const old = f.mistaken.id;
    f.sender.branchMessage(f.bot.threadId, old, "Different branch");
    f.sender.appendMessage(f.bot.threadId, { role: "user", kind: "text", text: "에디에게 보내" });
    expect(await f.service.handle({ ...f.args, action: "send", selected_message_id: old })).toHaveProperty("error");
    expect(f.calls()).toBe(0);
  });

  it.each(["offline", "legacy", "reject", "after-submit"] as const)("keeps an unsent draft on %s and deduplicates retry", async (failure) => {
    const f = await fixture();
    f.fail(failure);
    const result = await f.service.handle({ ...f.args, action: "send" });
    expect(result.state).toBe("unsent");
    expect(readFileSync(join(f.senderDir, "drafts", `${result.id}.json`), "utf8")).toContain(f.mistaken.text!);
    f.fail(null);
    f.sender.appendMessage(f.bot.threadId, { role: "user", kind: "text", text: "에디에게 보내" });
    const retried = await f.service.handle({ ...f.args, action: "retry", report_id: result.id });
    expect(retried).toMatchObject({ id: result.id, state: "accepted" });
    expect(await f.relay.claim()).toHaveLength(1);
  });

  it("keeps offline drafts only for previously authenticated enrollment and fails closed on revocation", async () => {
    const f = await fixture();
    expect(f.service.prompt()).toBe(TEAM_REPORT_RULE);
    f.link({ ...PHONE_RELAY_OFF, state: "reconnecting" });
    expect((await f.service.handle({ ...f.args, action: "send" })).state).toBe("unsent");
    expect(f.calls()).toBe(0);
    f.link(status); f.revoke();
    expect((await f.service.handle({ ...f.args, action: "send" })).state).toBe("unsent");
    expect(await f.relay.claim()).toEqual([]);
    f.enroll(false);
    expect(await f.service.handle({ ...f.args, action: "send" })).toHaveProperty("error");
  });

  it("redacts secrets before truncation and refuses escaped/oversized/secret-bearing image paths", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside.png"); writeFileSync(outside, png);
    const large = join(f.senderDir, "attachments", "large.png"); writeFileSync(large, Buffer.alloc(1024 * 1024 + 1));
    const secretImage = join(f.senderDir, "attachments", "secret.png"); writeFileSync(secretImage, Buffer.concat([png, Buffer.from("password=TopSecret12345")]));
    const text = `password=TopSecret12345\n${"가".repeat(20_000)}\n<attached-image path="${outside}" />\n<attached-image path="${large}" />\n<attached-image path="${secretImage}" />`;
    const selected = f.sender.appendMessage(f.bot.threadId, { role: "user", kind: "text", text });
    f.sender.appendMessage(f.bot.threadId, { role: "user", kind: "text", text: "에디에게 보내" });
    const result = await f.service.handle({ ...f.args, selected_message_id: selected.id, action: "send" });
    expect(result.state).toBe("accepted");
    const [held] = await f.relay.claim();
    expect(JSON.stringify(held)).not.toContain("TopSecret12345");
    expect(held.report.images.every((image) => image.messageId !== selected.id)).toBe(true);
    expect(held.report.originals.some((message) => message.truncated && message.redacted)).toBe(true);
    expect(held.report.missing.filter((line) => line.includes("refused"))).toHaveLength(3);
  });

  it("never claims filing if the owner cannot post a note or persist a receipt", async () => {
    const f = await fixture();
    await f.service.handle({ ...f.args, action: "send" });
    expect(await claimTeamReports({ ...f.ownerOptions, post: () => false })).toBe(0);
    expect(await f.relay.claim(Date.now() + 11 * 60_000)).toHaveLength(1);
    expect(await claimTeamReports({ ...f.ownerOptions, email: () => "someone@example.test" })).toBe(0);
  });

  it("preserves group speaker identity and rejects invented earlier references", async () => {
    const f = await fixture();
    const path = f.sender.activePath(f.bot.threadId);
    const options = { owner, bot: f.bot, threadId: f.bot.threadId, path: path.map((message) => message.id === f.mistaken.id ? { ...message, from: { botId: "peer", name: "Room peer", color: "blue" } } : message),
      request: f.authorization, selectedMessageId: f.mistaken.id, attachmentsDir: join(f.senderDir, "attachments"), roots: [], current: { engine: "now", model: "now", version: "now" } };
    expect(collectReport(options).originals.find((message) => message.id === f.mistaken.id)?.speaker).toBe("Room peer");
    expect(() => collectReport({ ...options, earlierMessageIds: ["foreign-message"] })).toThrow("outside");
  });

  it("binds the payload signature and team owner on the receiving service", async () => {
    const f = await fixture();
    const report = collectReport({ owner, bot: f.bot, threadId: f.bot.threadId, path: f.sender.activePath(f.bot.threadId), request: f.authorization,
      attachmentsDir: join(f.senderDir, "attachments"), roots: [], current: { engine: "x", model: "x", version: "x" } });
    const identity = loadOrCreateIdentity(f.senderDir);
    const auth = { idToken: token("teammate", "teammate@example.test"), ticket: "invalid", pk: identity.pk, sig: "A".repeat(86) };
    const signature = sign(null, reportPayload(owner, auth, report), identity.privateKey).toString("base64url");
    const register = vi.fn(async () => ({ ok: true as const, label: identity.label, subHash: "sender", account: "unused" }));
    expect((await f.relay.submit({ auth, signature, report: { ...report, summary: "tampered" } }, { register }, Date.now())).status).toBe(403);
    expect(register).not.toHaveBeenCalled();
    expect((await f.relay.submit({ auth, signature, report: { ...report, owner: "a".repeat(64) } }, { register }, Date.now())).status).toBe(403);
  });

  it("reports a real group incident in Korean with member speakers and excludes the private thread", async () => {
    const f = await fixture();
    const peer = f.sender.createBot({ name: "Peer" }, { seedMessages: false });
    const group = f.sender.createGroup("QA", [f.bot.id, peer.id], false, undefined, { completed: true });
    const user = f.sender.appendMessage(group.threadId, { role: "user", kind: "text", text: "작업을 계속해 주세요" });
    const answer = f.sender.appendMessage(group.threadId, { role: "bot", kind: "text", text: "작업을 중단했습니다", from: { botId: peer.id, name: "Peer", color: "blue" } });
    f.sender.appendMessage(group.threadId, { role: "user", kind: "text", text: "에디에게 보내" });
    const result = await f.service.handle({ fromBotId: f.bot.id, fromThreadId: group.threadId, action: "send", selected_message_id: answer.id });
    expect(result.state).toBe("accepted");
    const [held] = await f.relay.claim();
    expect(held.report.originals.map((message) => message.id)).toContain(user.id);
    expect(held.report.originals.find((message) => message.id === answer.id)?.speaker).toBe("Peer");
    expect(JSON.stringify(held)).not.toContain(f.mistaken.id);
    expect(f.calls()).toBe(1);
  });

  it("asks for the incident when no answer exists and never asks for approval", async () => {
    const f = await fixture();
    const fresh = f.sender.createBot({}, { seedMessages: false });
    f.sender.appendMessage(fresh.threadId, { role: "user", kind: "text", text: "에디에게 보내" });
    const result = await f.service.handle({ fromBotId: fresh.id, fromThreadId: fresh.threadId, action: "send" });
    expect(result.error).toContain("Incident unidentified");
    expect(f.calls()).toBe(0);
  });

  it("omits sensitive pixels when explicitly excluded and preserves the omission in the report", async () => {
    const f = await fixture();
    const result = await f.service.handle({ ...f.args, action: "send", exclude_image_message_ids: [f.image.id] });
    expect(result.state).toBe("accepted");
    const [held] = await f.relay.claim();
    expect(held.report.images).toHaveLength(0);
    expect(held.report.missing).toContain(`Images on ${f.image.id} excluded as sensitive or unrelated.`);
  });

  it("leases the owner claim, recovers after its deadline and retains duplicate protection across reopen", async () => {
    const f = await fixture();
    const result = await f.service.handle({ ...f.args, action: "send" });
    expect(await f.relay.claim()).toHaveLength(1);
    expect(await f.relay.claim()).toHaveLength(0);
    const reopened = new ReportStore(join(f.root, "relay"), ownerEmail);
    expect(await reopened.claim(Date.now() + 11 * 60_000)).toHaveLength(1);
    expect((await f.service.handle({ ...f.args, action: "retry", report_id: result.id })).state).toBe("accepted");
  });

  it("refuses retry evidence from an abandoned branch even when the selected answer is shared", async () => {
    const f = await fixture();
    f.fail("offline");
    const saved = await f.service.handle({ ...f.args, action: "send" });
    f.sender.branchMessage(f.bot.threadId, f.authorization.id, "에디에게 보내");
    f.fail(null);
    const result = await f.service.handle({ ...f.args, action: "retry", report_id: saved.id });
    expect(result.error).toContain("branch/sender/team");
    expect(await f.relay.claim()).toHaveLength(0);
  });

  it("rejects receiver owner access for a teammate account and refuses malformed receipts", async () => {
    const f = await fixture();
    const teammate = token("teammate", "teammate@example.test");
    expect(await claimTeamReports({ ...f.ownerOptions, tokens: { idToken: () => teammate, freshIdToken: async () => teammate } })).toBe(0);
    const collected = await f.service.handle({ ...f.args, action: "collect" });
    const report = JSON.parse(readFileSync(join(f.senderDir, "drafts", `${collected.id}.json`), "utf8")).report;
    await expect(sendTeamReport({ dataDir: f.senderDir, base: () => "team.example", tokens: { idToken: () => teammate, freshIdToken: async () => teammate },
      fetchImpl: (async () => new Response(JSON.stringify({ id: "b".repeat(32), state: "accepted", read: false }))) as typeof fetch }, report)).rejects.toThrow("ID mismatch");
  });

  it("recovers a failed owner acknowledgement after restart without another note or corrupt image", async () => {
    const f = await fixture();
    const sent = await f.service.handle({ ...f.args, action: "send" });
    const failAck = (async (url: string | URL | Request, init?: RequestInit) => String(url).endsWith("/ack")
      ? new Response("{}", { status: 503 }) : f.ownerOptions.fetchImpl(url, init)) as typeof fetch;
    await expect(claimTeamReports({ ...f.ownerOptions, fetchImpl: failAck })).rejects.toThrow("acknowledgement failed");
    expect(f.ownerStore.messagesFor(f.chief.threadId)).toHaveLength(1);
    const imageFile = join(f.ownerDir, "inbox", String(sent.id), "0.png");
    writeFileSync(imageFile, "interrupted image write");
    const later = Date.now() + 11 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    const restarted = await profile(f.ownerDir);
    expect(await claimTeamReports({ ...f.ownerOptions, ...reportOwnerPost(restarted, "owner-device") })).toBe(1);
    expect(restarted.messagesFor(f.chief.threadId)).toHaveLength(1);
    expect(readFileSync(imageFile)).toEqual(png);
  });

  it("rejects a foreign enrollment and another authenticated sender reusing a report ID", async () => {
    const f = await fixture();
    const sent = await f.service.handle({ ...f.args, action: "send" });
    const report = JSON.parse(readFileSync(join(f.senderDir, "drafts", `${sent.id}.json`), "utf8")).report;
    const otherDir = join(f.root, "other-sender");
    const identity = loadOrCreateIdentity(otherDir);
    const now = Math.floor(Date.now() / 1000);
    const claims = { label: identity.label, pk: identity.pk, iat: now, exp: now + 3600 };
    writeTicket(otherDir, signTicket(claims, generateKeyPairSync("ed25519").privateKey));
    const otherToken = token("other-teammate", "other@example.test");
    const options = { dataDir: otherDir, base: () => "team.example", tokens: { idToken: () => otherToken, freshIdToken: async () => otherToken }, fetchImpl: f.ownerOptions.fetchImpl };
    await expect(sendTeamReport(options, report)).rejects.toThrow("HTTP 403");
    writeTicket(otherDir, signTicket(claims, operator));
    await expect(sendTeamReport(options, report)).rejects.toThrow("HTTP 409");
    expect(await f.relay.claim()).toHaveLength(1);
  });

  it("includes bounded original diagnostic output and marks unavailable native output", async () => {
    const f = await fixture();
    f.sender.appendMessage(f.bot.threadId, { role: "bot", kind: "activity", tool: { name: "read", ok: false, detail: { input: "read requested file", output: ["ENOENT: incident file missing"], more: 5 } } });
    f.sender.appendMessage(f.bot.threadId, { role: "user", kind: "text", text: "에디에게 보내" });
    expect((await f.service.handle({ ...f.args, action: "send" })).state).toBe("accepted");
    const [held] = await f.relay.claim();
    expect(held.report.diagnostics).toContain("ENOENT: incident file missing");
    expect(held.report.missing.some((line) => line.includes("truncated or hidden"))).toBe(true);
  });
});
