import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { shellMade } from "./shell-made.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copied() {
  const cwd = mkdtempSync(join(tmpdir(), "shell-made-"));
  roots.push(cwd);
  const shots = join(cwd, "launch outside task", "real-shots");
  mkdirSync(join(cwd, "source"), { recursive: true });
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(cwd, "source", "a.png"), "a");
  const since = Date.now();
  copyFileSync(join(cwd, "source", "a.png"), join(shots, "a.png"));
  return { cwd, shots, since };
}

it("names files copied into a quoted folder, not the sources a glob read", () => {
  const { cwd, shots, since } = copied();
  expect(shellMade(`cp source/*.png "launch outside task/real-shots/"`, cwd, since)).toEqual([join(shots, "a.png")]);
  expect(shellMade(`Copy-Item -Path 'source\\*.png' -Destination '${shots}'`, cwd, since)).toEqual([join(shots, "a.png")]);
});

it("names nothing the command did not change", () => {
  const { cwd, shots } = copied();
  expect(shellMade(`ls "${shots}"`, cwd, Date.now() + 60_000)).toEqual([]);
  expect(shellMade("echo https://example.com //server/share", cwd, 0)).toEqual([]);
});
