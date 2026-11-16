import { describe, expect, it } from "vitest";

import { compatibleDoorEntry, type DoorEntry } from "./door-streams.ts";

describe("room file compatibility", () => {
  it("keeps large metadata off old snapshots and stream frames", () => {
    const files = Array.from({ length: 50 }, (_, index) => ({ id: String(index).padStart(24, "a"), name: `계획-${index}.pdf`, bytes: index === 0 ? 1024 ** 3 : 10, type: "application/pdf", sha256: "0".repeat(64) }));
    const entry: DoorEntry = { seq: 1, id: "line1", at: Date.now(), author: { kind: "host", id: "host", name: "Edward" }, text: "shared", files };
    const old = compatibleDoorEntry(entry, false);
    expect(old.files).toHaveLength(10);
    expect(old.files!.every((file) => file.bytes <= 25 * 1024 ** 2)).toBe(true);
    expect(old.text).toContain(files[0]!.name);
    expect(compatibleDoorEntry(entry, true)).toBe(entry);
    expect(Buffer.byteLength(JSON.stringify({ kind: "entry", entry }))).toBeLessThan(256 * 1024);
    const stress = { ...entry, text: "가".repeat(20_000), files: files.map((file) => ({ ...file, name: "가".repeat(196) + ".pdf" })) };
    expect(Buffer.byteLength(JSON.stringify({ kind: "entry", entry: stress }))).toBeLessThan(256 * 1024);
  });

  it("never names a deleted file to an old client", () => {
    const file = { id: "a".repeat(24), name: "private-plan.pdf", bytes: 10, type: "application/pdf", sha256: "0".repeat(64), deleted: true };
    const entry: DoorEntry = { seq: 1, id: "line1", at: Date.now(), author: { kind: "host", id: "host", name: "Edward" }, text: "shared", files: [file] };
    expect(compatibleDoorEntry(entry, false)).toMatchObject({ files: [], text: "shared" });
  });
});
