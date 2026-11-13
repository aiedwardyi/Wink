import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { localMediaFile } from "./media-file.mjs";

test("resolves existing pictures, attachments and hosted room files", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wink-media-file-"));
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
