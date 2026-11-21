// attachments.ts: save + read-back, the mime allowlist, size ceiling, and
// the name-lock that keeps the serving route inside the attachments dir.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeTestData, testHome } from "./testing/test-home.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: Object.assign(vi.fn(actual.realpathSync), { native: vi.fn(actual.realpathSync.native) }),
    statSync: vi.fn(actual.statSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

// The module reads DATA_DIR at import time, so the env var must be set
// before the import is evaluated.
const DATA_ROOT = mkdtempSync(join(testHome(), "omb-attachments-"));
process.env.OMB_DATA_DIR = join(DATA_ROOT, "data");

const { ATTACHMENTS_DIR, IMAGE_MAX_BYTES, extensionForMime, importLocalImage, readAttachment, receiveAttachment, saveImage, sharableLocalFile, sniffImageMime } = await import("./attachments.ts");

function uploadRequest(name: string | undefined, chunks: Buffer[], mime = "application/octet-stream") {
  const req = new IncomingMessage(new Socket());
  req.headers["content-type"] = mime;
  if (name !== undefined) req.headers["x-attachment-name"] = encodeURIComponent(name);
  const saved = receiveAttachment(req);
  for (const chunk of chunks) req.emit("data", chunk);
  req.emit("end");
  return saved;
}

describe("document uploads", () => {
  afterEach(() => {
    removeTestData(ATTACHMENTS_DIR);
  });

  it.each(["pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "txt", "md", "csv", "json"])("stores .%s bytes under a random name", async (ext) => {
    const saved = await uploadRequest(`윙크.${ext}`, [Buffer.from("document")]);
    const second = await uploadRequest(`윙크.${ext}`, [Buffer.from("document")]);
    expect(dirname(saved.path)).toBe(ATTACHMENTS_DIR);
    expect(basename(saved.path)).toMatch(new RegExp(`^[a-f0-9-]{36}\\.${ext}$`));
    expect(saved.path).not.toBe(second.path);
    expect(saved).toMatchObject({ name: `윙크.${ext}`, bytes: 8 });
    expect(readFileSync(saved.path).toString()).toBe("document");
    expect(readAttachment(basename(saved.path))).toBeNull();
  });

  it("neutralizes traversal and control characters in display metadata", async () => {
    const saved = await uploadRequest("../../private\\윙크\r\n.docx", [Buffer.from("doc")]);
    expect(saved.name).toBe("윙크.docx");
    expect(dirname(saved.path)).toBe(ATTACHMENTS_DIR);
    expect(basename(saved.path)).toMatch(/^[a-f0-9-]{36}\.docx$/);
  });

  it("accepts 25 MB and rejects a stream over the limit with status 413", async () => {
    const bytes = Buffer.alloc(25 * 1024 * 1024);
    expect((await uploadRequest("limit.PDF", [bytes])).bytes).toBe(bytes.length);
    await expect(uploadRequest("big.pdf", [bytes, Buffer.from("x")])).rejects.toMatchObject({ status: 413, message: expect.stringContaining("exceeds") });
  });

  it.each(["run.exe", "run.docx.exe", "page.html", "image.svg", "file", "file.pdf:run.exe"])("rejects %s", async (name) => {
    await expect(uploadRequest(name, [Buffer.from("x")])).rejects.toMatchObject({ status: 400 });
  });

  it("preserves the image limit and rejects empty documents and missing names", async () => {
    await expect(uploadRequest("empty.txt", [])).rejects.toMatchObject({ status: 400 });
    await expect(uploadRequest(undefined, [Buffer.from("x")], "text/plain")).rejects.toMatchObject({ status: 400 });
    await expect(uploadRequest(undefined, [Buffer.alloc(IMAGE_MAX_BYTES + 1)], "image/png")).rejects.toMatchObject({ status: 413 });
    const image = await uploadRequest(undefined, [Buffer.from("png")], "image/png");
    expect(image.mime).toBe("image/png");
    expect(readAttachment(basename(image.path))?.bytes.toString()).toBe("png");
  });
});

describe("extensionForMime", () => {
  it("maps the accepted image mimes to extensions", () => {
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
    expect(extensionForMime("image/gif")).toBe(".gif");
    expect(extensionForMime("image/webp")).toBe(".webp");
  });

  it("tolerates parameters and casing", () => {
    expect(extensionForMime("Image/PNG; charset=binary")).toBe(".png");
    expect(extensionForMime("  image/webp  ")).toBe(".webp");
  });

  it("refuses everything else — including svg, which executes script", () => {
    expect(extensionForMime("image/svg+xml")).toBeNull();
    expect(extensionForMime("text/plain")).toBeNull();
    expect(extensionForMime(undefined)).toBeNull();
  });
});

describe("saveImage", () => {
  beforeEach(() => {
    removeTestData(ATTACHMENTS_DIR);
  });
  afterEach(() => {
    removeTestData(ATTACHMENTS_DIR);
  });

  it("persists bytes under the attachments dir with a generated name", () => {
    const saved = saveImage(Buffer.from("png-bytes"), "image/png");
    expect(saved.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(saved.path.endsWith(".png")).toBe(true);
    expect(saved.bytes).toBe(9);
    expect(saved.mime).toBe("image/png");
    if (process.platform !== "win32") {
      expect(statSync(ATTACHMENTS_DIR).mode & 0o777).toBe(0o700);
      expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    }
  });

  it("round-trips through readAttachment with the right mime", () => {
    const saved = saveImage(Buffer.from("gif!"), "image/gif");
    const name = saved.path.split(/[\\/]/).pop()!;
    const back = readAttachment(name);
    expect(back?.bytes.toString()).toBe("gif!");
    expect(back?.mime).toBe("image/gif");
  });

  it("rejects unsupported mimes, empty bodies, and oversize bodies", () => {
    expect(() => saveImage(Buffer.from("x"), "image/svg+xml")).toThrow(/unsupported image type/);
    expect(() => saveImage(Buffer.alloc(0), "image/png")).toThrow(/empty/);
    expect(() => saveImage(Buffer.alloc(IMAGE_MAX_BYTES + 1), "image/png")).toThrow(/exceeds/);
  });
});

describe("readAttachment name lock", () => {
  beforeEach(() => {
    removeTestData(ATTACHMENTS_DIR);
  });
  afterEach(() => {
    removeTestData(ATTACHMENTS_DIR);
  });

  it("refuses traversal, dotfiles, and names the saver never writes", () => {
    expect(readAttachment("..%2F..%2Fconfig.json")).toBeNull();
    expect(readAttachment(".env")).toBeNull();
    expect(readAttachment("a/b.png")).toBeNull();
    expect(readAttachment("no-extension")).toBeNull();
    expect(readAttachment("uuid.jpeg")).toBeNull(); // saved as .jpg
  });
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);

describe("sniffImageMime", () => {
  it("reads the format from magic bytes", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from("GIF89a..."))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("RIFF....WEBPVP8 "))).toBe("image/webp");
  });

  it("refuses text and svg", () => {
    expect(sniffImageMime(Buffer.from("not an image"))).toBeNull();
    expect(sniffImageMime(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe("importLocalImage", () => {
  const src = join(DATA_ROOT, "src");
  const outside = join(DATA_ROOT, "outside");
  const roots = [src];
  beforeEach(() => {
    removeTestData(ATTACHMENTS_DIR);
    mkdirSync(src, { recursive: true });
    mkdirSync(outside, { recursive: true });
  });
  afterEach(() => {
    removeTestData(ATTACHMENTS_DIR);
    removeTestData(src);
    removeTestData(outside);
  });

  it("copies a real PNG into the store under a generated name", () => {
    const file = join(src, "mockup.png");
    writeFileSync(file, PNG);
    const saved = importLocalImage(file, roots);
    expect(saved.mime).toBe("image/png");
    expect(saved.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(saved.name).not.toContain("mockup");
    expect(readAttachment(saved.name)?.bytes.equals(PNG)).toBe(true);
  });

  it("accepts a file nested inside any allowed root", () => {
    mkdirSync(join(outside, "shots"), { recursive: true });
    const file = join(outside, "shots", "a.png");
    writeFileSync(file, PNG);
    expect(importLocalImage(file, [src, outside]).mime).toBe("image/png");
  });

  it("stores by sniffed format, not by extension", () => {
    const file = join(src, "shot.jpg");
    writeFileSync(file, PNG);
    expect(importLocalImage(file, roots).name.endsWith(".png")).toBe(true);
  });

  it("rejects a text file named .png", () => {
    const file = join(src, "fake.png");
    writeFileSync(file, "hello");
    expect(() => importLocalImage(file, roots)).toThrow(/not a PNG, JPEG, GIF, or WebP/);
  });

  it("rejects missing, relative, directory, empty, and oversized paths", () => {
    expect(() => importLocalImage(join(src, "nope.png"), roots)).toThrow(/file not found/);
    expect(() => importLocalImage("mockup.png", roots)).toThrow(/absolute/);
    expect(() => importLocalImage(src, roots)).toThrow(/regular file/);
    const empty = join(src, "empty.png");
    writeFileSync(empty, "");
    expect(() => importLocalImage(empty, roots)).toThrow(/empty/);
    const big = join(src, "big.png");
    writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES)]));
    expect(() => importLocalImage(big, roots)).toThrow(/exceeds/);
  });

  it("rejects UNC and device paths before touching the filesystem", () => {
    const calls = [fs.realpathSync, fs.realpathSync.native, fs.statSync, fs.readFileSync].map((fn) => vi.mocked(fn));
    for (const path of ["\\\\server\\share\\a.png", "//server/share/a.png", "\\\\?\\C:\\a.png", "\\\\.\\C:\\a.png"]) {
      calls.forEach((fn) => fn.mockClear());
      expect(() => importLocalImage(path, roots)).toThrow(expect.objectContaining({ status: 403 }));
      calls.forEach((fn) => expect(fn).not.toHaveBeenCalled());
    }
  });

  it("rejects a file outside every root with a 403 that says where to save", () => {
    const file = join(outside, "private.png");
    writeFileSync(file, PNG);
    expect(() => importLocalImage(file, roots)).toThrow(
      expect.objectContaining({ status: 403, message: expect.stringContaining("project or workspace folder") }),
    );
    expect(() => importLocalImage(file, roots)).toThrow(roots.join(", "));
    expect(() => importLocalImage(file, roots)).toThrow(file);
    expect(() => importLocalImage(file, [])).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("names the submitted path in missing and relative path errors", () => {
    const missing = join(src, "nope.png");
    expect(() => importLocalImage(missing, roots)).toThrow(`${missing}: file not found`);
    expect(() => importLocalImage("mockup.png", roots)).toThrow("mockup.png");
    expect(() => importLocalImage("mockup.png", roots)).toThrow(roots.join(", "));
  });

  it("rejects a link inside a root that resolves outside it", () => {
    writeFileSync(join(outside, "private.png"), PNG);
    symlinkSync(outside, join(src, "escape"), "junction");
    expect(() => importLocalImage(join(src, "escape", "private.png"), roots)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
});

describe("sharableLocalFile", () => {
  const project = join(DATA_ROOT, "project");
  beforeEach(() => mkdirSync(join(project, ".secretdir"), { recursive: true }));
  afterEach(() => removeTestData(project));
  const shortName = (dir: string, name: string) => execFileSync("cmd.exe", ["/d", "/c", "dir", "/x", "/a"], { cwd: dir, encoding: "utf8", windowsHide: true })
    .split(/\r?\n/).find((line) => line.trim().endsWith(` ${name}`))?.match(/\s(\S*~\d+\S*)\s+\S+$/)?.[1];

  it.runIf(process.platform === "win32")("refuses dot files named by their Windows short names", (context) => {
    writeFileSync(join(project, ".env"), "SECRET=1");
    writeFileSync(join(project, ".secretdir", "credentials.json"), "{}");
    writeFileSync(join(project, "notes.txt"), "ok");
    const env = shortName(project, ".env");
    const dir = shortName(project, ".secretdir");
    const creds = shortName(join(project, ".secretdir"), "credentials.json");
    if (!env || !dir || !creds) return context.skip();
    expect(sharableLocalFile(join(project, "notes.txt"), [project]).size).toBe(2);
    for (const path of [join(project, env), join(project, dir, creds)]) {
      expect(() => sharableLocalFile(path, [project]), path).toThrow(expect.objectContaining({ status: 403 }));
    }
  });
});

describe("show-image route", () => {
  const indexSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8").replace(/\r\n/g, "\n");
  const internalSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "internal-routes.ts"), "utf8");
  const route = internalSource.slice(internalSource.indexOf("showImage: async ("), internalSource.indexOf("generateImage: async ("));

  it("publishes into the sender's own thread as a screen message", () => {
    expect(route).toContain("connectorThread(from.id, fromThreadId)");
    expect(route).toContain("importLocalImage(String(body.path ?? \"\"), roots)");
    expect(route).toContain("workspaceDir(from.id)");
    expect(route).toContain('kind: "screen"');
    expect(route).toMatch(/shared \? \{[^}]*roomFiles: shared\.roomFiles[^}]*\} : \{ image: saved\.name \}/);
    expect(route).toContain("shown: true");
    expect(route).not.toContain("png:");
    expect(route).toContain("url: shared?.url ?? `/api/attachments/${saved.name}`");
  });

  it("tells bots about show_image only when the agents integration is mounted", () => {
    expect(indexSource).toContain('const showImagePrompt = canMessage ? ` ${slimStaticText(SHOW_IMAGE_GUIDANCE, instance.driverKind)}` : "";');
    expect(indexSource).toContain("canMessage && SHOW_IMAGE_GUIDANCE");
  });

  it("puts the always-reply, say-once and default-voice rules in every bot's base prompt", () => {
    const constants = indexSource.slice(indexSource.indexOf("const ALWAYS_REPLY_FUNCTIONAL_INSTRUCTIONS ="), indexSource.indexOf("const CORPUS_SEARCH_INSTRUCTIONS ="));
    expect(runInNewContext(constants + "ALWAYS_REPLY_INSTRUCTIONS")).toContain("for a question, the short answer");
    expect(runInNewContext(constants + "ALWAYS_REPLY_INSTRUCTIONS")).toContain("Say what you verified yourself and what you assume or were told.");
    expect(JSON.stringify(runInNewContext(constants + "ALWAYS_REPLY_INSTRUCTIONS"))).toBe("\" When reporting after time away, in a summary or wrap-up, or after helpers finish, list every finished deliverable and every item waiting on the user, each with its picture or clickable link. If any part of what the user asked was skipped, cut, left for them to do by hand, or failed, say so in plain words at the top of that reply. Keep it short and drop nothing. If the user answers an open card in their own words, close the card. Always give a visible reply to a message the user types. A turn woken by a pane note, helper report, peer note or other automated message ends with no text at all (no '.', '⏳' or status line; call no_reply_needed first if you have it) unless what the user asked for is ready and checked, they must decide or act, or something live changed for them. If the user writes while you work, reply immediately in one short visible line (for a question, the short answer; for a correction or instruction, acknowledge it), then continue unless they asked you to stop or pause; thinking alone is not a reply. When a Wink note with their message says a fast reply answers it, skip that line and continue. If that line answered it, do not recap or expand it in your final reply unless later work changed the answer or a Wink note says the user never saw it; then send the answer once more. This applies to user-typed messages, not automated notes. Text outside tool calls appears in chat: never write notes to yourself or your next step there ('Now the tests.', 'Need X.', a bare filename); make the tool call. Some engines replace long between-tool text with a summary the user never sees. Give the full answer once, after your last tool call, with every detail, link and list the user must read exactly. Before then, give at most one short activity line, never the answer, so the final reply does not repeat it. Write every line, including mid-turn text, in the user's language. Say each thing once: repeat no information or status from this or earlier turns unless it changed. If a user-started turn brings nothing new, reply in one short line. For a decision or input needed to continue, use ask_user so it gets noticed; reply text alone is insufficient. The tool does not pause you. After verifying a task's result, remove its temporary files, folders and worktrees you created, by exact path only. Never delete by wildcard, age or anything you did not create; ask when unsure. Say what you verified yourself and what you assume or were told. Name who did or checked each thing (you, a helper, CI, the user), never 'we'; call a cause likely until reproduced. Quote numbers only from sources you opened; name the run, file or date. Before proposing, planning or building, follow existing work and decisions (feature list, status board, decision notes, memory); say first if your plan would redo or contradict them. In any build card, hand-off or note, each thing the user decided or asked quotes their words with the date, like: \\\"use cards\\\" (Nov 17). Mark everything else 'suggestion, not agreed' and ask before building it. When the user changes their mind, replace the old note; never keep two that disagree. Judge ideas on merit; plainly say when the user's idea is wrong or low value. If you change your mind, say what convinced you. State usage limits plainly, with a known reset time. Never promise to resume yourself; chat shows whether Wink will continue. Default voice (role description and user requests override it, including length and teaching style): answer first, 2-5 short lines, the few key points unless asked for every option, plain words, a few bullets over paragraphs, warm like a friend on the user's side. Celebrate real wins, name frustration in a few words before fixing it, and never flatter ordinary messages or agree when the user is wrong. Work out questions before answering. Skip preamble, recaps and generic closing offers; needed questions and asking before acting are not padding. Give code, plans, drafts, commands and anything to paste or follow step by step in full. Otherwise go longer only when asked or needed, still verdict first.\"");
    expect(indexSource.split(" : ALWAYS_REPLY_INSTRUCTIONS) +").length - 1).toBe(2);
  });
});
