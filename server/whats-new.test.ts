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
  it("never shows on a fresh install, then shows after the next update", () => {
    expect(openWhatsNew(root, "1.0.246").pending()).toBeNull();
    expect(seenFile()).toEqual({ seen: "1.0.246" });
    writeFileSync(join(root, "bots.json"), "[]");
    expect(openWhatsNew(root, "1.0.246").pending()).toBeNull();
    expect(openWhatsNew(root, "1.0.247").pending()).toBe("1.0.247");
  });

  it("shows once on an install that ran a build from before the record", () => {
    writeFileSync(join(root, "bots.json"), "[]");
    const first = openWhatsNew(root, "1.0.246");
    expect(first.pending()).toBe("1.0.246");
    first.markSeen("1.0.246");
    expect(first.pending()).toBeNull();
    expect(openWhatsNew(root, "1.0.246").pending()).toBeNull();
  });

  it("keeps a newer release pending when a stale card marks an older one seen", () => {
    writeFileSync(join(root, "bots.json"), "[]");
    const open = openWhatsNew(root, "1.0.247");
    open.markSeen("1.0.246");
    open.markSeen(undefined);
    expect(open.pending()).toBe("1.0.247");
    expect(openWhatsNew(root, "1.0.247").pending()).toBe("1.0.247");
  });

  it("keeps it pending across restarts until seen", () => {
    writeFileSync(join(root, "bots.json"), "[]");
    writeFileSync(join(root, "whats-new.json"), JSON.stringify({ seen: "1.0.245" }));
    expect(openWhatsNew(root, "1.0.246").pending()).toBe("1.0.246");
    expect(openWhatsNew(root, "1.0.246").pending()).toBe("1.0.246");
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
    expect(openWhatsNew(root, "").pending()).toBeNull();
  });
});
