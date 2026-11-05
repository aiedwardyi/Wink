import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ATTACHMENTS_DIR } from "./attachments.ts";
import * as attachmentsModule from "./attachments.ts";
import { createBotRoutes } from "./bot-routes.ts";
import { DATA_DIR } from "./config.ts";
import { createInternalRoutes } from "./internal-routes.ts";
import type { BotRecord, Store } from "./store.ts";
import { removeTempDir } from "./testing/cleanup.ts";

vi.mock("./config.ts", async (importOriginal) => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { ...await importOriginal<typeof import("./config.ts")>(), DATA_DIR: mkdtempSync(join(tmpdir(), "wink-picture-gate-")) };
});

const pixels = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const looked = "2026-11-05T10:43:00+09:00";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let folder: string;
let stamps: string;
let path: string;
let bot: BotRecord;
let appendMessage: ReturnType<typeof vi.fn>;
let store: Store;

beforeEach(() => {
  folder = mkdtempSync(join(DATA_DIR, "case-"));
  stamps = join(folder, "stamps");
  mkdirSync(stamps);
  path = join(folder, "picture.gif");
  writeFileSync(path, pixels);
  bot = { id: "teacher", threadId: "thread", name: "Teacher", color: "green", cwd: folder } as BotRecord;
  appendMessage = vi.fn((_threadId: string, _message: Record<string, unknown>) => ({ id: "message" }));
  store = {
    bot: (id: string) => id === bot.id ? bot : undefined,
    taskByThread: () => undefined,
    groupTaskByThread: () => undefined,
    patchBot: (_id: string, patch: Partial<BotRecord>) => Object.assign(bot, patch),
    appendMessage,
  } as unknown as Store;
});

afterAll(async () => {
  expect(existsSync(join(DATA_DIR, "messages.db"))).toBe(false);
  await removeTempDir(DATA_DIR);
});

async function call(route: (req: IncomingMessage, res: ServerResponse) => Promise<void>, body: object) {
  let status = 0;
  let raw = "";
  const res = { writeHead(code: number) { status = code; }, end(value: string) { raw = value; } } as ServerResponse;
  const req = new EventEmitter() as IncomingMessage;
  const pending = route(req, res);
  req.emit("data", JSON.stringify(body));
  req.emit("end");
  await pending;
  return { status, raw, body: JSON.parse(raw) };
}

function routes(group = false) {
  return createInternalRoutes({
    cfg: { imageGen: { key: "test-key" } }, store,
    connectorThread: () => ({ ...(group ? { group: { id: "group" } } : {}) }),
    botOutputRoots: () => [folder],
  } as unknown as Parameters<typeof createInternalRoutes>[0]);
}

function show(group = false) {
  return call(routes(group).showImage, { fromBotId: bot.id, fromThreadId: bot.threadId, path, caption: "  Picture  " });
}

function patch(hooks: unknown) {
  const route = createBotRoutes({ store, wireBot: (record: BotRecord) => record } as unknown as Parameters<typeof createBotRoutes>[0]);
  return call((req, res) => route.patch(req, res, ["", bot.id]), { hooks });
}

function gate() {
  Object.assign(bot, { hooks: { pictures: { stamps } } });
}

function stamp(fields: Record<string, unknown> = {}, bytes = pixels) {
  writeFileSync(join(stamps, `${hash(bytes)}.json`), JSON.stringify({ v: 1, sha256: hash(bytes), pass: true, looked, ...fields }));
}

const attachments = () => existsSync(ATTACHMENTS_DIR) ? readdirSync(ATTACHMENTS_DIR) : [];

async function refused(reason: string) {
  const before = attachments();
  const result = await show();
  expect(result).toMatchObject({ status: 403, body: { error: `picture gate: ${reason}. Run picture-gate check ${path}` } });
  expect(appendMessage).not.toHaveBeenCalled();
  expect(attachments()).toEqual(before);
  expect(readFileSync(path)).toEqual(pixels);
}

describe("picture gate routes", () => {
  it("refuses a picture with no stamp and removes only its imported copy", async () => {
    gate();
    await refused("stamp missing");
  });

  it("refuses a passed stamp that has not been looked at", async () => {
    gate();
    stamp({ looked: null });
    await refused("stamp not looked at");
  });

  it("refuses the old stamp after one pixel changes", async () => {
    gate();
    stamp();
    const changed = Buffer.from(pixels);
    changed[13] = 255;
    writeFileSync(path, changed);
    const before = attachments();
    const result = await show();
    expect(result.status).toBe(403);
    expect(result.body.error).toContain("picture gate: stamp missing.");
    expect(appendMessage).not.toHaveBeenCalled();
    expect(attachments()).toEqual(before);
    expect(readFileSync(path)).toEqual(changed);
  });

  it("shows a valid stamp after enabling hooks through PATCH", async () => {
    const hooks = { pictures: { stamps } };
    expect(await patch(hooks)).toMatchObject({ status: 200, body: { bot: { hooks } } });
    stamp();
    const result = await show();
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ messageId: "message", url: expect.stringMatching(/^\/api\/attachments\/.+\.gif$/) });
    const row = appendMessage.mock.calls[0][1];
    expect(row).toEqual({ role: "bot", kind: "screen", image: expect.any(String), shown: true, text: "Picture" });
    expect(readFileSync(join(ATTACHMENTS_DIR, row.image))).toEqual(pixels);
  });

  it.each([undefined, true, false])("saves generated pictures without showing for a gated bot (show %s)", async (show) => {
    gate();
    const before = attachments();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: pixels.toString("base64") }] }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    try {
      const result = await call(routes().generateImage, { fromBotId: bot.id, fromThreadId: bot.threadId, prompt: "picture", show });
      expect(result.status).toBe(201);
      expect(result.body).toEqual({ path: expect.any(String) });
      expect(readFileSync(result.body.path)).toEqual(pixels);
      expect(appendMessage).not.toHaveBeenCalled();
      expect(attachments()).toEqual(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restores the identical ungated response after clearing hooks", async () => {
    const original = await show();
    gate();
    expect((await show()).status).toBe(403);
    expect(await patch(null)).toMatchObject({ status: 200 });
    expect(bot.hooks).toBeUndefined();
    appendMessage.mockClear();
    const result = await show();
    const normalize = (raw: string) => raw.replace(/[a-f0-9-]{36}\.gif/g, "image.gif");
    expect(normalize(result.raw)).toBe(normalize(original.raw));
    expect(result.status).toBe(original.status);
    expect(appendMessage).toHaveBeenCalledOnce();
  });

  it.each([undefined, true, false])("preserves ungated generation responses (show %s)", async (show) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: pixels.toString("base64") }] }))));
    try {
      const result = await call(routes().generateImage, { fromBotId: bot.id, fromThreadId: bot.threadId, prompt: "picture", show });
      expect(result.status).toBe(201);
      expect(readFileSync(result.body.path)).toEqual(pixels);
      if (show === false) {
        expect(result.body).toEqual({ path: expect.any(String) });
        expect(appendMessage).not.toHaveBeenCalled();
      } else {
        expect(result.body).toEqual({ path: expect.any(String), messageId: "message", url: expect.stringMatching(/^\/api\/attachments\/.+\.png$/) });
        expect(appendMessage.mock.calls[0][1]).toEqual({ role: "bot", kind: "screen", image: expect.any(String), shown: true });
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("checks imported bytes when the source changes after import", async () => {
    gate();
    const changed = Buffer.from(pixels);
    changed[13] = 255;
    stamp({}, changed);
    const importImage = attachmentsModule.importLocalImage;
    const spy = vi.spyOn(attachmentsModule, "importLocalImage").mockImplementationOnce((source, roots) => {
      const saved = importImage(source, roots);
      writeFileSync(source, changed);
      return saved;
    });
    const before = attachments();
    try {
      expect((await show()).status).toBe(403);
      expect(appendMessage).not.toHaveBeenCalled();
      expect(attachments()).toEqual(before);
      expect(readFileSync(path)).toEqual(changed);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ["stamp hash does not match", { sha256: "0".repeat(64) }],
    ["stamp did not pass", { pass: false }],
    ["stamp did not pass", { pass: "true" }],
    ["stamp not looked at", { looked: "" }],
    ["stamp not looked at", { looked: true }],
    ["stamp not looked at", { looked: "not a time" }],
  ])("refuses %s (%j)", async (reason, fields) => {
    gate();
    stamp(fields);
    await refused(reason);
  });

  it.each(["{", "null", "[]"])("fails closed on an unreadable stamp (%s)", async (contents) => {
    gate();
    writeFileSync(join(stamps, `${hash(pixels)}.json`), contents);
    await refused("stamp unreadable");
  });

  it("accepts byte-identical copies in a group conversation", async () => {
    gate();
    stamp();
    path = join(folder, "copy.gif");
    writeFileSync(path, pixels);
    expect((await show(true)).status).toBe(201);
    expect(appendMessage.mock.calls[0][1].from).toEqual({ botId: bot.id, name: bot.name, color: bot.color });
  });

  it.each([42, [], { pictures: {} }, { pictures: { stamps: "relative" } }, { pictures: { stamps: "" } }, { launch: { check: "later" } }, { watch: [] }].map((hooks) => [hooks]))("rejects invalid or reserved hooks in PATCH (%j)", async (hooks) => {
    expect((await patch(hooks)).status).toBe(400);
    expect(bot).not.toHaveProperty("hooks");
  });
});
