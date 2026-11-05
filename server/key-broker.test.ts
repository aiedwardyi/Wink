import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CredentialConfig } from "../shared/credential-request.ts";
import { callApi, callApiRequestSchema, CALL_API_TEXT_CHARS, loadKeyUses, missingKeyMessage, recordKeyUse } from "./key-broker.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: vi.fn(actual.realpathSync),
    statSync: vi.fn(actual.statSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

const KEY = "xai-secretKEY1234567890";
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omb-key-broker-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const request = (fields: Record<string, unknown>) =>
  callApiRequestSchema.parse({ credentialId: "xaiApiKey", method: "GET", url: "https://api.x.ai/v1/models", ...fields });
const keys: CredentialConfig = {
  xai: { key: KEY },
  tts: { key: KEY },
  anthropic: { key: KEY },
  vertex: { key: KEY },
  customKeys: { "api.acme.dev": { name: "Acme", header: "x-acme-key", prefix: "Token ", key: KEY } },
};
const reply = (body: string, init: ResponseInit = { status: 200 }) => vi.fn<typeof fetch>(async () => new Response(body, init));

describe("call_api", () => {
  it("sends multipart bytes and fields with a boundary and keeps the key in its header", async () => {
    const path = join(root, "speech.m4a");
    const bytes = Buffer.from([0, 1, 255, 13, 10]);
    writeFileSync(path, bytes);
    const fetchMock = reply(`echo ${KEY}`);
    const result = await callApi(request({ method: "POST", headers: { "Content-Type": "application/json" }, form: {
      fields: { model: "asr", language: "한국어" }, files: [{ field: "audio", path }],
    } }), keys, [root], fetchMock);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(init!.body).toBeInstanceOf(FormData);
    expect((init!.headers as Headers).has("content-type")).toBe(false);
    const wire = new Request(url, init);
    expect(wire.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=.+/);
    expect(wire.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(Buffer.from(await wire.clone().arrayBuffer()).includes(KEY)).toBe(false);
    const form = await wire.formData();
    expect([...form.keys()]).toEqual(["model", "language", "audio"]);
    expect(form.get("language")).toBe("한국어");
    expect(form.get("model")).toBe("asr");
    const file = form.get("audio") as File;
    expect(file.name).toBe("speech.m4a");
    expect(file.type).toBe("audio/mp4");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
    expect(result).toEqual({ status: 200, text: "HTTP 200\necho [key]" });
  });

  it.each([
    ["mp3", "audio/mpeg"], ["wav", "audio/wav"], ["webm", "audio/webm"],
    ["png", "image/png"], ["JPG", "image/jpeg"], ["jpeg", "image/jpeg"], ["webp", "image/webp"],
    ["pdf", "application/pdf"], ["custom", "application/octet-stream"],
  ])("infers the multipart type for .%s", async (ext, type) => {
    const path = join(root, `upload.${ext}`);
    writeFileSync(path, "bytes");
    const fetchMock = reply("");
    await callApi(request({ method: "POST", form: { files: [{ field: "file", path }] } }), keys, [root], fetchMock);
    const file = (fetchMock.mock.calls[0]![1]!.body as FormData).get("file") as File;
    expect(file.type).toBe(type);
    expect(file.name).toBe(`upload.${ext}`);
  });

  it("uses caller multipart metadata and accepts text-only and empty forms", async () => {
    const path = join(root, "upload.bin");
    writeFileSync(path, "bytes");
    const fetchMock = reply("");
    for (const form of [{ files: [{ field: "file", path, filename: "renamed.txt", content_type: "text/plain" }] }, { fields: { q: "x" } }, {}]) {
      await callApi(request({ method: "POST", form }), keys, [root], fetchMock);
    }
    const first = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect(first.get("file")).toMatchObject({ name: "renamed.txt", type: "text/plain" });
    expect((fetchMock.mock.calls[1]![1]!.body as FormData).get("q")).toBe("x");
    expect([...(fetchMock.mock.calls[2]![1]!.body as FormData).keys()]).toEqual([]);
  });

  it.each([
    ["outside", 403], ["missing", 404], ["relative", 400],
  ])("refuses a multipart %s path", async (kind, status) => {
    const path = kind === "outside" ? join(root, "outside.wav") : kind === "missing" ? join(root, "missing.wav") : "relative.wav";
    if (kind === "outside") writeFileSync(path, "bytes");
    const fetchMock = reply("");
    await expect(callApi(request({ method: "POST", form: { files: [{ field: "file", path }] } }), keys,
      kind === "outside" ? [join(root, "allowed")] : [root], fetchMock)).rejects.toMatchObject({ status });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["\\\\server\\share\\file.wav", "//server/share/file.wav", "\\\\?\\C:\\file.wav", "\\\\.\\pipe\\file"])("refuses multipart network/device path %s before fs access", async (path) => {
    vi.mocked(fs.realpathSync).mockClear();
    vi.mocked(fs.statSync).mockClear();
    vi.mocked(fs.readFileSync).mockClear();
    const fetchMock = reply("");
    await expect(callApi(request({ method: "POST", form: { files: [{ field: "file", path }] } }), keys, [root], fetchMock))
      .rejects.toMatchObject({ status: 403 });
    expect(fs.realpathSync).not.toHaveBeenCalled();
    expect(fs.statSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["file", "request", "count"])("caps multipart %s uploads with 413", async (kind) => {
    const path = join(root, "large.bin");
    writeFileSync(path, "x");
    truncateSync(path, 25 * 1024 * 1024 + (kind === "file" ? 1 : 0));
    const files = Array.from({ length: kind === "count" ? 9 : kind === "request" ? 3 : 1 }, () => ({ field: "file", path }));
    const fetchMock = reply("");
    await expect(callApi(request({ method: "POST", form: { files } }), keys, [root], fetchMock))
      .rejects.toMatchObject({ status: 413, message: expect.stringContaining("exceeds") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts multipart limits of 25 MB per file, 50 MB total, and eight files", async () => {
    const path = join(root, "limit.bin");
    writeFileSync(path, "x");
    truncateSync(path, 25 * 1024 * 1024);
    const empty = join(root, "empty.bin");
    writeFileSync(empty, "");
    const files = Array.from({ length: 8 }, (_, i) => ({ field: `file${i}`, path: i < 2 ? path : empty }));
    const fetchMock = reply("");
    await callApi(request({ method: "POST", form: { files } }), keys, [root], fetchMock);
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect([...form.keys()]).toHaveLength(8);
    expect((form.get("file0") as File).size).toBe(25 * 1024 * 1024);
    expect((form.get("file1") as File).size).toBe(25 * 1024 * 1024);
    expect((form.get("file7") as File).size).toBe(0);
  });

  it.each(["text", {}, null])("rejects multipart with body %j in the schema and broker", async (body) => {
    expect(callApiRequestSchema.safeParse({ ...request({ body }), form: {} }).success).toBe(false);
    const fetchMock = reply("");
    await expect(callApi({ ...request({ body }), form: {} } as ReturnType<typeof request>, keys, [root], fetchMock))
      .rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["raw text", { q: 1 }])("preserves the existing body %j without a form", async (body) => {
    const fetchMock = reply("");
    await callApi(request({ method: "POST", body }), keys, [root], fetchMock);
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.body).toBe(typeof body === "string" ? body : JSON.stringify(body));
    expect((init.headers as Headers).get("content-type")).toBe(typeof body === "string" ? null : "application/json");
  });

  it("injects the key into that service's header and returns status and body", async () => {
    const fetchMock = reply(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    const result = await callApi(request({ method: "POST", body: { q: 1 } }), keys, [root], fetchMock);

    expect(result).toEqual({ status: 200, text: 'HTTP 200\n{"data":[]}' });
    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init!.headers as Headers;
    expect(String(url)).toBe("https://api.x.ai/v1/models");
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(init).toMatchObject({ method: "POST", body: '{"q":1}', redirect: "manual" });

    await callApi(request({ credentialId: "ttsKey", url: "https://api.elevenlabs.io/v1/voices" }), keys, [root], fetchMock);
    expect((fetchMock.mock.calls[1]![1]!.headers as Headers).get("xi-api-key")).toBe(KEY);

    await callApi(request({ credentialId: "anthropicApiKey", url: "https://api.anthropic.com/v1/messages" }), keys, [root], fetchMock);
    expect((fetchMock.mock.calls[2]![1]!.headers as Headers).get("x-api-key")).toBe(KEY);
    await callApi(request({ credentialId: "vertexApiKey", url: "https://aiplatform.googleapis.com/v1/publishers/google/models" }), keys, [root], fetchMock);
    expect((fetchMock.mock.calls[3]![1]!.headers as Headers).get("x-goog-api-key")).toBe(KEY);
  });

  it.each([
    ["http://api.x.ai/v1/models", 400],
    ["https://api.openai.com/v1/models", 403],
    ["https://api.x.ai.evil.com/v1", 403],
    ["https://api.x.ai:8443/v1", 403],
    ["not a url", 400],
  ])("refuses %s", async (url, status) => {
    const fetchMock = reply("");
    await expect(callApi(request({ url }), keys, [root], fetchMock)).rejects.toMatchObject({ status });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses box, a bot-supplied auth header, and a missing key", async () => {
    const fetchMock = reply("");
    await expect(callApi(request({ credentialId: "boxToken" }), keys, [root], fetchMock))
      .rejects.toThrow("Box API Key is not available through call_api.");
    await expect(callApi(request({ headers: { Authorization: "Bearer mine" } }), keys, [root], fetchMock))
      .rejects.toMatchObject({ status: 400 });
    await expect(callApi(request({ credentialId: "geminiApiKey", url: "https://generativelanguage.googleapis.com/v1beta/models" }), keys, [root], fetchMock))
      .rejects.toMatchObject({ status: 409, message: missingKeyMessage("geminiApiKey") });
    expect(missingKeyMessage("geminiApiKey")).toContain("request_credential with geminiApiKey, end the turn, then retry");
    expect(missingKeyMessage("xaiApiKey")).toContain("If a signed-in engine can do the job");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("locks a custom key to its exact host, header, and prefix", async () => {
    const fetchMock = reply(`echo ${KEY}`, { status: 200 });
    const result = await callApi(request({ credentialId: "custom:api.acme.dev", url: "https://api.acme.dev/v1/items" }), keys, [root], fetchMock);
    expect((fetchMock.mock.calls[0]![1]!.headers as Headers).get("x-acme-key")).toBe(`Token ${KEY}`);
    expect(JSON.stringify(result)).not.toContain(KEY);

    for (const url of ["https://evil.test/v1", "https://eu.api.acme.dev/v1", "https://api.acme.dev.evil.test/v1", "http://api.acme.dev/v1"]) {
      await expect(callApi(request({ credentialId: "custom:api.acme.dev", url }), keys, [root], fetchMock)).rejects.toMatchObject({ status: expect.any(Number) });
    }
    await expect(callApi(request({ credentialId: "custom:api.acme.dev", url: "https://api.acme.dev/v1", headers: { "X-Acme-Key": "mine" } }), keys, [root], fetchMock))
      .rejects.toMatchObject({ status: 400 });
    await expect(callApi(request({ credentialId: "custom:api.other.dev", url: "https://api.other.dev/v1" }), keys, [root], fetchMock))
      .rejects.toMatchObject({ status: 409, message: missingKeyMessage("custom:api.other.dev") });
    expect(missingKeyMessage("custom:api.other.dev")).toContain('credential_id "custom"');
    await expect(callApi(request({ credentialId: "custom:localhost", url: "https://localhost/" }), keys, [root], fetchMock))
      .rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not follow redirects", async () => {
    const result = await callApi(request({}), keys, [root], reply("", { status: 302, headers: { location: "https://evil.test" } }));
    expect(result).toEqual({ status: 302, text: "HTTP 302: redirect not followed" });
  });

  it("redacts the key and truncates long text", async () => {
    const result = await callApi(request({}), keys, [root], reply(`bad key ${KEY} ${"x".repeat(CALL_API_TEXT_CHARS)}`, { status: 401 }));
    expect(result.status).toBe(401);
    expect("text" in result && result.text).toMatch(/^HTTP 401\nbad key \[key\] x+\n\[truncated\]$/);
    const failing = vi.fn<typeof fetch>(async () => { throw new Error(`connect failed for ${KEY}`); });
    await expect(callApi(request({}), keys, [root], failing)).rejects.toThrow("connect failed for [key]");
  });

  it("saves binary responses under api-files", async () => {
    const result = await callApi(request({}), keys, [root], reply("mp3-bytes", { status: 200, headers: { "content-type": "audio/mpeg" } }));
    expect(result).toMatchObject({ status: 200, contentType: "audio/mpeg" });
    const path = (result as { path: string }).path;
    expect(dirname(path)).toBe(join(root, "api-files"));
    expect(path).toMatch(/response-[0-9a-f]{8}\.mp3$/);
    expect(readFileSync(path, "utf8")).toBe("mp3-bytes");
  });

  it("never puts a key that is not a valid header value in the error", async () => {
    const bad = "line1secret\nline2secret";
    const fetchMock = reply("");
    const error = await callApi(request({ credentialId: "custom:api.acme.dev", url: "https://api.acme.dev/v1" }), {
      customKeys: { "api.acme.dev": { name: "Acme", header: "authorization", prefix: "Bearer ", key: bad } },
    }, [root], fetchMock).catch((e: Error) => e);
    expect(error).toMatchObject({ status: 400 });
    expect((error as Error).message).not.toContain("line1secret");
    expect((error as Error).message).not.toContain("line2secret");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to save a binary response that echoes the key", async () => {
    const echo = vi.fn<typeof fetch>(async (_url, init) => new Response(
      `auth=${(init!.headers as Headers).get("x-acme-key")}`,
      { status: 200, headers: { "content-type": "application/octet-stream" } },
    ));
    await expect(callApi(request({ credentialId: "custom:api.acme.dev", url: "https://api.acme.dev/v1" }), keys, [root], echo))
      .rejects.toMatchObject({ status: 502, message: expect.stringContaining("echoed the key") });
    expect(existsSync(join(root, "api-files"))).toBe(false);
  });

  it("caps the response size and times out", async () => {
    const big = reply("x", { status: 200, headers: { "content-length": String(20 * 1024 * 1024) } });
    await expect(callApi(request({}), keys, [root], big)).rejects.toMatchObject({ status: 502 });
    const hang = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    await expect(callApi(request({}), keys, [root], hang, 10)).rejects.toMatchObject({ status: 504 });
  });
});

describe("key uses", () => {
  it("records the last bot and time per credential", () => {
    expect(loadKeyUses(root)).toEqual({});
    recordKeyUse(root, "xaiApiKey", "bot-a", new Date("2026-09-01T00:00:00Z"));
    recordKeyUse(root, "ttsKey", "bot-b", new Date("2026-09-02T00:00:00Z"));
    recordKeyUse(root, "xaiApiKey", "bot-c", new Date("2026-09-03T00:00:00Z"));
    expect(loadKeyUses(root)).toEqual({
      xaiApiKey: { botId: "bot-c", at: "2026-09-03T00:00:00.000Z" },
      ttsKey: { botId: "bot-b", at: "2026-09-02T00:00:00.000Z" },
    });
  });
});
