import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openCallIntro } from "./call-intro.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omb-call-intro-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("call intro", () => {
  it("is answered once and stays answered after a restart", () => {
    const intro = openCallIntro(root);
    expect(intro.seen()).toBe(false);
    intro.markSeen();
    expect(intro.seen()).toBe(true);
    expect(openCallIntro(root).seen()).toBe(true);
  });
});
