import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { reportOwnerHash, reportPayload, type TeamReport } from "../../shared/team-report.ts";
import { safeImageMetadata } from "../../shared/image-metadata.ts";
import { redactSecretsInText } from "../../shared/redact.ts";
import type { Accounts } from "../src/accounts.ts";
import { createLogger } from "../src/log.ts";
import { reportHttp } from "../src/reports-http.ts";
import { ReportStore } from "../src/reports.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

function chunk(type: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const content = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(content));
  return Buffer.concat([size, content, crc]);
}

function screenshot(metadata = false): Buffer {
  const pixels = Buffer.from("password=PixelPattern123 https://example.test/?token=PixelPattern123 ");
  const header = Buffer.alloc(13); header.writeUInt32BE(pixels.length, 0); header.writeUInt32BE(1, 4); header[8] = 8;
  const data = deflateSync(Buffer.concat([Buffer.from([0]), pixels]), { level: 0 });
  expect(inflateSync(data).subarray(1)).toEqual(pixels);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    ...(metadata ? [chunk("tEXt", Buffer.from("Comment\0password=MetadataSecret123"))] : []), chunk("IDAT", data), chunk("IEND", Buffer.alloc(0))]);
}

async function fixture(bytes: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), "report-relay-")); dirs.push(dir);
  const owner = reportOwnerHash("edward@example.test");
  const keys = generateKeyPairSync("ed25519");
  const auth = { idToken: "token", ticket: "ticket", pk: keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"), sig: "A".repeat(86) };
  const report: TeamReport = { id: "a".repeat(32), owner, at: 1, bot: { id: "helper", name: "Helper" }, threadId: "thread", branchId: "request", selectedMessageId: "request", requestMessageId: "request",
    summary: "Broken sidebar", diagnosis: "", originals: [], images: [{ messageId: "request", mime: "image/png", base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), source: "stored-message", collectedAt: 1 }],
    diagnostics: "", incident: { engine: "unknown", model: "unknown", version: "unknown" }, current: { engine: "fixture", model: "fixture", version: "fixture" }, missing: [] };
  const envelope = { auth, report, signature: sign(null, reportPayload(owner, auth, report), keys.privateKey).toString("base64url") };
  const accounts = { register: async () => ({ ok: true as const, label: "abcdefghijklmnop", subHash: "subject", account: "unused" }) };
  return { store: new ReportStore(dir, "edward@example.test"), envelope, accounts };
}

describe("report image validation", () => {
  it("R5 accepts real PNG pixel data resembling credentials without scanning IDAT", async () => {
    const bytes = screenshot(); expect(bytes.toString("latin1")).toContain("password=PixelPattern123");
    const f = await fixture(bytes);
    expect((await f.store.submit(f.envelope, f.accounts, Date.now())).status).toBe(200);
    expect(Buffer.from((await f.store.claim())[0]!.report.images[0]!.base64, "base64")).toEqual(bytes);
  });
  it("rejects secrets in PNG text metadata", async () => {
    const f = await fixture(screenshot(true));
    expect((await f.store.submit(f.envelope, f.accounts, Date.now())).body).toEqual({ error: "bad-image" });
  });
  it.each(["zTXt", "iTXt"])("rejects compressed PNG %s metadata secrets", (type) => {
    const text = deflateSync(Buffer.from("password=MetadataSecret123"));
    const data = Buffer.concat([Buffer.from(type === "zTXt" ? "Comment\0\0" : "Comment\0\x01\0\0\0"), text]);
    const bytes = screenshot();
    const withMetadata = Buffer.concat([bytes.subarray(0, 33), chunk(type, data), bytes.subarray(33)]);
    expect(safeImageMetadata(withMetadata, "image/png", redactSecretsInText)).toBe(false);
  });
  it("scans JPEG comments while leaving scan data opaque", () => {
    const text = Buffer.from("password=MetadataSecret123");
    const size = Buffer.alloc(2); size.writeUInt16BE(text.length + 2);
    const scan = Buffer.concat([Buffer.from("ffd8ffda0002", "hex"), text, Buffer.from("ffd9", "hex")]);
    expect(safeImageMetadata(scan, "image/jpeg", redactSecretsInText)).toBe(true);
    const comment = Buffer.concat([Buffer.from("ffd8fffe", "hex"), size, text, scan.subarray(2)]);
    expect(safeImageMetadata(comment, "image/jpeg", redactSecretsInText)).toBe(false);
  });
});

describe("report HTTP errors", () => {
  it.each(["submit", "claim", "ack"])("R6 logs unexpected %s failures without report contents", async (route) => {
    const logs: string[] = [];
    const req = Readable.from([Buffer.from(route === "ack" ? '{"ids":[]}' : '{}')]) as IncomingMessage;
    req.method = "POST"; req.url = `/v1/team/reports/${route}`;
    req.headers = { "content-type": "application/json", authorization: "Bearer e30.e30.fixture" };
    let status = 0;
    const res = { writeHead: (code: number) => { status = code; }, end() {} } as unknown as ServerResponse;
    const fail = async () => { throw new TypeError("private report password=DoNotLog123"); };
    const options = { accounts: { owner: async () => ({ ok: true }) } as unknown as Accounts,
      reports: { submit: fail, claim: fail, ack: fail } as unknown as ReportStore, owner: "edward@example.test", now: Date.now,
      log: createLogger((line) => logs.push(line)) };
    await reportHttp(req, res, options);
    expect(status).toBe(503);
    expect(logs.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ event: "reports-error", route, reason: "unexpected" })]);
    expect(logs.join(" ")).not.toMatch(/private report|DoNotLog123|password/);
  });
});
