import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWhatsNew, releaseOf } from "./whats-new.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omb-whats-new-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const seenFile = () => JSON.parse(readFileSync(join(root, "whats-new.json"), "utf8"));

describe("whats new", () => {
  it("never shows on a fresh install, then offers the next update", () => {
    expect(openWhatsNew(root, "1.0.246").pending()).toBeNull();
    expect(seenFile()).toEqual({ seen: "1.0.246" });
    writeFileSync(join(root, "bots.json"), "[]");
    expect(openWhatsNew(root, "1.0.246").pending()).toBeNull();
    expect(openWhatsNew(root, "1.0.247").pending()).toEqual({ release: "1.0.247", seen: "1.0.246" });
  });

  it("shows once on an install that ran a build from before the record", () => {
    writeFileSync(join(root, "bots.json"), "[]");
    const first = openWhatsNew(root, "1.0.246");
    expect(first.pending()).toEqual({ release: "1.0.246", seen: null });
    first.markSeen("1.0.246");
    expect(first.pending()).toBeNull();
    expect(openWhatsNew(root, "1.0.246").pending()).toBeNull();
  });

  it("records the notes shown after a skipped release, not the running one", () => {
    writeFileSync(join(root, "bots.json"), "[]");
    writeFileSync(join(root, "whats-new.json"), JSON.stringify({ seen: "1.0.245" }));
    const open = openWhatsNew(root, "1.0.247");
    expect(open.pending()).toEqual({ release: "1.0.247", seen: "1.0.245" });
    open.markSeen("1.0.246");
    expect(seenFile()).toEqual({ seen: "1.0.246" });
    expect(open.pending()).toEqual({ release: "1.0.247", seen: "1.0.246" });
    expect(openWhatsNew(root, "1.0.248").pending()).toEqual({ release: "1.0.248", seen: "1.0.246" });
  });

  it("shows notes skipped by an install from before the record", () => {
    writeFileSync(join(root, "bots.json"), "[]");
    const open = openWhatsNew(root, "1.0.248");
    expect(open.pending()).toEqual({ release: "1.0.248", seen: null });
    open.markSeen("1.0.246");
    expect(seenFile()).toEqual({ seen: "1.0.246" });
  });

  it("keeps a newer release pending when a stale card marks an older one seen", () => {
    writeFileSync(join(root, "bots.json"), "[]");
    writeFileSync(join(root, "whats-new.json"), JSON.stringify({ seen: "1.0.245" }));
    const open = openWhatsNew(root, "1.0.248");
    open.markSeen("1.0.246");
    expect(open.pending()).toEqual({ release: "1.0.248", seen: "1.0.246" });
    open.markSeen("1.0.248");
    open.markSeen("1.0.246");
    expect(seenFile()).toEqual({ seen: "1.0.248" });
    expect(open.pending()).toBeNull();
  });

  it("ignores a seen mark that is not a release up to the running one", () => {
    writeFileSync(join(root, "bots.json"), "[]");
    writeFileSync(join(root, "whats-new.json"), JSON.stringify({ seen: "1.0.245" }));
    const open = openWhatsNew(root, "1.0.247");
    for (const shown of [undefined, 1, "", "latest", "1.0.246-dev.1", "1.0.248", "1.0.245", "1.0.244"]) open.markSeen(shown);
    expect(seenFile()).toEqual({ seen: "1.0.245" });
    expect(open.pending()).toEqual({ release: "1.0.247", seen: "1.0.245" });
  });

  it("leaves the record alone on a release nobody marks seen", () => {
    writeFileSync(join(root, "bots.json"), "[]");
    writeFileSync(join(root, "whats-new.json"), JSON.stringify({ seen: "1.0.246" }));
    expect(openWhatsNew(root, "1.0.247").pending()).toEqual({ release: "1.0.247", seen: "1.0.246" });
    expect(seenFile()).toEqual({ seen: "1.0.246" });
    expect(openWhatsNew(root, "1.0.248").pending()).toEqual({ release: "1.0.248", seen: "1.0.246" });
  });

  it("keeps it pending across restarts until seen", () => {
    writeFileSync(join(root, "bots.json"), "[]");
    writeFileSync(join(root, "whats-new.json"), JSON.stringify({ seen: "1.0.245" }));
    expect(openWhatsNew(root, "1.0.246").pending()).toEqual({ release: "1.0.246", seen: "1.0.245" });
    expect(openWhatsNew(root, "1.0.246").pending()).toEqual({ release: "1.0.246", seen: "1.0.245" });
  });

  it("never shows on a downgrade or the same release", () => {
    writeFileSync(join(root, "bots.json"), "[]");
    writeFileSync(join(root, "whats-new.json"), JSON.stringify({ seen: "1.0.246" }));
    expect(openWhatsNew(root, "1.0.246").pending()).toBeNull();
    expect(openWhatsNew(root, "1.0.245").pending()).toBeNull();
  });

  it("shares one release across its dev builds", () => {
    expect(releaseOf("1.0.246-dev.3")).toBe("1.0.246");
    writeFileSync(join(root, "bots.json"), "[]");
    openWhatsNew(root, "1.0.246-dev.2").markSeen("1.0.246");
    expect(openWhatsNew(root, "1.0.246-dev.3").pending()).toBeNull();
  });

  it("does nothing without a version", () => {
    expect(openWhatsNew(root, "").pending()).toBeNull();
    writeFileSync(join(root, "bots.json"), "[]");
    const open = openWhatsNew(root, "");
    open.markSeen("1.0.246");
    expect(open.pending()).toBeNull();
    expect(() => seenFile()).toThrow();
  });

  it("keeps where the card showed until it is seen", () => {
    writeFileSync(join(root, "bots.json"), "[]");
    writeFileSync(join(root, "whats-new.json"), JSON.stringify({ seen: "1.0.245" }));
    const open = openWhatsNew(root, "1.0.247");
    for (const [shown, id] of [["1.0.248", "m1"], ["1.0.245", "m1"], ["1.0.246", ""], ["1.0.246", 7]]) open.place(shown, id);
    expect(seenFile()).toEqual({ seen: "1.0.245" });
    open.place("1.0.246", "m1");
    expect(seenFile()).toEqual({ seen: "1.0.245", anchor: { release: "1.0.246", id: "m1" } });
    expect(openWhatsNew(root, "1.0.247").pending()).toEqual({ release: "1.0.247", seen: "1.0.245", anchor: { release: "1.0.246", id: "m1" } });
    open.markSeen("1.0.246");
    expect(seenFile()).toEqual({ seen: "1.0.246" });
  });

  it("reads a record whose anchor it cannot parse", () => {
    writeFileSync(join(root, "bots.json"), "[]");
    writeFileSync(join(root, "whats-new.json"), JSON.stringify({ seen: "1.0.245", anchor: "m1" }));
    expect(openWhatsNew(root, "1.0.247").pending()).toEqual({ release: "1.0.247", seen: "1.0.245" });
  });
});
