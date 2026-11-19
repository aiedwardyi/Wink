import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { shellMade } from "./shell-made.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copied(count = 1) {
  const cwd = mkdtempSync(join(tmpdir(), "shell-made-"));
  roots.push(cwd);
  const shots = join(cwd, "launch outside task", "real-shots");
  mkdirSync(join(cwd, "source"), { recursive: true });
  mkdirSync(shots, { recursive: true });
  const names = Array.from({ length: count }, (_, index) => count === 1 ? "a.png" : `${String(index + 1).padStart(3, "0")}.png`);
  for (const name of names) writeFileSync(join(cwd, "source", name), name);
  const since = Date.now();
  for (const name of names) copyFileSync(join(cwd, "source", name), join(shots, name));
  return { cwd, shots, since, made: names.map((name) => join(shots, name)) };
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

it("follows a directory change before a relative destination", () => {
  const { cwd, shots, since } = copied();
  const task = join(cwd, "task");
  mkdirSync(task);
  const outside = join(cwd, "launch outside task");
  expect(shellMade(`cd "${outside}" && cp ../source/*.png real-shots/`, task, since)).toEqual([join(shots, "a.png")]);
  expect(shellMade(`Set-Location -LiteralPath '${outside}'; Copy-Item -Path 'x\\*.png' -Destination 'real-shots' -ErrorAction Stop`, task, since)).toEqual([join(shots, "a.png")]);
  expect(shellMade(`echo cd; cp x real-shots`, outside, since)).toEqual([join(shots, "a.png")]);
});

it("keeps every file a large copy made", () => {
  const { cwd, shots, since, made } = copied(33);
  expect(shellMade(`Copy-Item -Path 'source\\*.png' -Destination '${shots}'`, cwd, since).sort()).toEqual(made);
});

it("names a folder too large to list", () => {
  const { cwd, shots, since } = copied(513);
  const listed = shellMade(`cp source/*.png "${shots}"`, cwd, since);
  expect(listed).toContain(shots);
  expect(listed).toHaveLength(513);
});
