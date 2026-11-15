import { afterEach, describe, expect, it, vi } from "vitest";

import { intakeFiles, uploadAttachmentFile } from "./composer-attachments";
import { applyLocale, t } from "./i18n";

type Fake = Pick<File, "name" | "size" | "type" | "text" | "arrayBuffer">;
const file = (name: string, type: string, size = 10): Fake => ({
  name,
  size,
  type,
  text: async () => "contents",
  arrayBuffer: async () => new ArrayBuffer(size),
});
const onDisk = (f: Fake) => `/Users/me/${f.name}`;

afterEach(() => {
  vi.unstubAllGlobals();
  applyLocale("en");
});

describe("browser document intake", () => {
  it.each(["pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "txt", "md", "csv", "json"])("shows a pathless .%s as an upload chip before any byte is sent", async (ext) => {
    const saved = { path: `/host/attachments/random.${ext}`, name: `윙크.${ext}`, bytes: 8, mime: "application/octet-stream" };
    const fetcher = vi.fn(async () => Response.json(saved, { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    const picked = new File(["contents"], `윙크.${ext}`);
    const out = await intakeFiles([picked], { t, allowImages: false, getPath: () => "" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(out.attachments).toEqual([expect.objectContaining({ kind: "upload", name: picked.name, document: true, state: "uploading" })]);
    expect(out.uploads).toEqual([{ id: out.attachments[0]!.id, file: picked }]);
    expect(out.notice).toBeNull();
    expect(await uploadAttachmentFile(picked, true)).toEqual(saved);
    expect(fetcher).toHaveBeenCalledWith("/api/attachments", expect.objectContaining({
      method: "POST",
      headers: new Headers({ "content-type": "application/octet-stream", "x-attachment-name": encodeURIComponent(picked.name) }),
      body: new TextEncoder().encode("contents"),
    }));
  });

  it.each(["en", "ko"] as const)("localizes a file over 10 GB in %s", async (locale) => {
    applyLocale(locale);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const out = await intakeFiles([file("huge.iso", "", 10 * 1024 ** 3 + 1)], {
      t, allowImages: true, getPath: () => "",
    });
    expect(out.attachments).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(out.notice).toContain("huge.iso");
    expect(out.notice).toContain(locale === "ko" ? "10GB까지" : "over 10 GB");
    expect(out.notice).not.toMatch(/Finder|File Explorer/);
  });

  it("keeps desktop paths even for unsupported types and large documents", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const out = await intakeFiles([file("big.docx", "", 30 * 1024 * 1024), file("script.html", "text/html")], {
      t, allowImages: false, getPath: onDisk,
    });
    expect(out.attachments.map((a) => a.kind)).toEqual(["file", "file"]);
    expect(out.notice).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps documents and pictures in order, each on the upload queue", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const out = await intakeFiles([file("plan.docx", ""), file("notes.txt", "text/plain"), file("shot.png", "image/png")], {
      t, allowImages: true, getPath: () => "",
    });
    expect(out.attachments.map((a) => "name" in a && a.name)).toEqual(["plan.docx", "notes.txt", "shot.png"]);
    expect(out.uploads.map((upload) => upload.id)).toEqual(out.attachments.map((a) => a.id));
    expect(fetcher).not.toHaveBeenCalled();
    expect(out.notice).toBeNull();
  });
});

describe("intakeFiles", () => {
  it("uploads images and keeps ordinary files as paths", async () => {
    const out = await intakeFiles([file("shot.png", "image/png"), file("notes.txt", "text/plain")], {
      t, allowImages: true,
      getPath: onDisk,
    });
    expect(out.attachments.map((a) => [a.kind, "name" in a ? a.name : ""])).toEqual([
      ["upload", "shot.png"],
      ["file", "notes.txt"],
    ]);
    expect(out.notice).toBeNull();
  });

  it("treats an image as an ordinary file when the engine cannot read one", async () => {
    const out = await intakeFiles([file("shot.png", "image/png")], {
      t, allowImages: false,
      getPath: onDisk,
    });
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0].kind).toBe("file");
  });

  it("names the files it could not take, rather than dropping them in silence", async () => {
    const out = await intakeFiles([{ ...file("ghost.bin", "application/octet-stream", 10 * 1024 ** 3 + 1) }], {
      t, allowImages: true,
      getPath: () => "",
    });
    expect(out.attachments).toHaveLength(0);
    expect(out.notice).toMatch(/ghost\.bin/);
  });

  it("keeps a small pathless text file outside the document types as a paste chip", async () => {
    const out = await intakeFiles([file("notes.log", "text/plain")], { t, allowImages: false, getPath: () => "" });
    expect(out.attachments.map((attachment) => attachment.kind)).toEqual(["paste"]);
    expect(out.notice).toBeNull();
  });

  it("hands every picture to the upload queue in order", async () => {
    const out = await intakeFiles([file("ok.png", "image/png"), file("bad.png", "image/png")], {
      t, allowImages: true,
      getPath: onDisk,
    });
    expect(out.attachments.map((a) => "name" in a && a.name)).toEqual(["ok.png", "bad.png"]);
    expect(out.uploads.map((upload) => upload.id)).toEqual(out.attachments.map((a) => a.id));
    expect(out.notice).toBeNull();
  });

  it("uploads a pathless image for an engine that reads images inline", async () => {
    const out = await intakeFiles([file("shot.png", "image/png")], {
      t, allowImages: true,
      getPath: () => "",
    });
    expect(out.attachments).toEqual([expect.objectContaining({ kind: "upload", name: "shot.png", picture: "image", state: "uploading" })]);
    expect(out.notice).toBeNull();
  });

  it("uploads a pathless image as a file chip for an engine that cannot read images", async () => {
    const out = await intakeFiles([file("shot.png", "image/png")], {
      t, allowImages: false,
      getPath: () => "",
    });
    expect(out.attachments).toEqual([expect.objectContaining({ kind: "upload", name: "shot.png", picture: "file" })]);
    expect(out.notice).toBeNull();
  });
});
