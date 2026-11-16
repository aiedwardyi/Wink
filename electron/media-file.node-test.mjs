import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { localMediaFile, registerMediaImageIpc } from "./media-file.mjs";

test("resolves existing pictures, attachments and hosted room files", async () => {
  const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), "wink-media-file-")));
  const id = "aB0_-cD1".repeat(3);
  const picture = path.join(dataDir, "chart.png");
  const attachment = path.join(dataDir, "attachments", "photo.png");
  const room = path.join(dataDir, "room-files", "r1", id);
  try {
    await mkdir(path.dirname(attachment), { recursive: true });
    await mkdir(path.dirname(room), { recursive: true });
    await Promise.all([picture, attachment, room].map((file) => writeFile(file, "png")));
    const options = { dataDir };
    assert.equal(await localMediaFile({ path: picture }, options), picture);
    assert.equal(await localMediaFile({ src: "/api/attachments/photo.png" }, options), attachment);
    assert.equal(await localMediaFile({ src: `/api/rooms/r1/files/${id}/preview` }, options), room);
    assert.equal(await localMediaFile({ path: path.join(dataDir, "gone.png") }, options), null);
    assert.equal(await localMediaFile({ path: dataDir }, options), null);
    for (const src of ["/api/attachments/..%2Fchart.png", "/api/attachments/..%5Cchart.png", "/api/attachments/%ZZ", "https://other.test/api/attachments/photo.png", `/api/joined-rooms/r1/files/${id}`]) {
      assert.equal(await localMediaFile({ src }, options), null);
    }
    const moved = path.join(dataDir, "moved");
    await mkdir(path.join(moved, "r1"), { recursive: true });
    await writeFile(path.join(moved, "r1", id), "png");
    await writeFile(path.join(dataDir, "room-files-folder.json"), JSON.stringify({ path: moved }));
    assert.equal(await localMediaFile({ src: `/api/rooms/r1/files/${id}` }, options), path.join(moved, "r1", id));
    await writeFile(path.join(dataDir, "room-files-folder.json"), "broken");
    assert.equal(await localMediaFile({ src: `/api/rooms/r1/files/${id}` }, options), null);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("image IPC bypasses renderer CORS, keeps names and guards callers and credentials", async () => {
  const handlers = new Map();
  const calls = [];
  const writes = [];
  const dialogs = [];
  const sender = {};
  const origin = "http://127.0.0.1:8973";
  const downloads = tmpdir();
  registerMediaImageIpc({ handle: (name, run) => handlers.set(name, run) }, {
    trusted: (event) => event === sender,
    optionsFor: () => ({
      origin, token: "local-only",
      fetchImpl: async (src, init) => { calls.push({ src, init }); return { ok: true, headers: new Headers({ "content-type": "image/png" }), arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer }; },
      downloads,
      dialog: { showSaveDialog: async (_window, options) => { dialogs.push(options); return { canceled: false, filePath: path.join(downloads, "saved.png") }; } },
      fsp: { writeFile: async (...args) => writes.push(args) },
    }),
  });
  const read = handlers.get("desktop:read-media-image");
  const save = handlers.get("desktop:save-media-image");
  await assert.rejects(read({}, "https://images.example.test/a.png"), /Untrusted/);
  await assert.rejects(save({}, "https://images.example.test/a.png", "a.png"), /Untrusted/);
  await assert.rejects(read(sender, "file:///secret.png"), /invalid/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await read(sender, "/api/attachments/a.png"), { bytes: new Uint8Array([1, 2, 3]), type: "image/png" });
  assert.equal(calls[0].src, `${origin}/api/attachments/a.png`);
  assert.equal(calls[0].init.headers.Authorization, "Bearer local-only");
  await read(sender, "https://images.example.test/a.png");
  assert.equal(calls[1].init?.headers?.Authorization, undefined);
  assert.equal(await save(sender, "https://images.example.test/opaque-id", "photo.png"), true);
  assert.equal(dialogs[0].defaultPath, path.join(downloads, "photo.png"));
  assert.deepEqual(writes[0][1], new Uint8Array([1, 2, 3]));
});
