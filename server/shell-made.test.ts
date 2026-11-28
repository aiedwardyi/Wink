import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { shellMade } from "./shell-made.ts";
import { chatMemory } from "./turn-context.ts";

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

it("names a folder past the listing bound even when its first entries are untouched, since a change may sit past the bound", () => {
  const { cwd, shots, made } = copied(514);
  const since = Date.now() + 60_000;
  expect(shellMade(`ls "${shots}"`, cwd, since)).toEqual([shots]);
  utimesSync(made.at(-1)!, new Date(since), new Date(since));
  const found = shellMade(`Get-ChildItem -LiteralPath '${shots}' -Filter '514.png' | ForEach-Object { Add-Content -LiteralPath $_.FullName -Value 'more' }`, cwd, since);
  expect(found).toContain(shots);
  const memory = chatMemory({ record: null, messages: [{ tool: { made: found } }], cwd });
  expect(memory).toContain("launch outside task 1 (real-shots)");
});

it("keeps every file past the listing bound in a folder made long before, and the folder as base named it", () => {
  const { cwd, shots, made } = copied(523);
  const since = Date.now() + 60_000;
  const late = made.slice(-11);
  for (const path of late) utimesSync(path, new Date(since), new Date(since));
  const found = shellMade(`cp source/*.png "${shots}"`, cwd, since);
  expect(found.slice().sort()).toEqual([...late, shots].sort());
  const memory = chatMemory({ record: null, messages: [{ tool: { made: found } }], cwd });
  expect(memory).toContain(`${join("launch outside task", "real-shots")} 11 (`);
  expect(memory).toContain("launch outside task 1 (real-shots)");
  for (const path of made) utimesSync(path, new Date(since), new Date(since));
  expect(shellMade(`cp source/*.png "${shots}"`, cwd, since).sort()).toEqual([...made, shots].sort());
});

it("leaves out a folder past the listing bound that only a walk base misread listed, so it takes no real folder's place", () => {
  const { cwd, shots } = copied(0);
  const since = Date.now() + 60_000;
  const outputs = ["out-a", "out-b", "out-c"];
  const made = [...outputs.map((name) => join(cwd, name)), shots].flatMap((folder) => {
    mkdirSync(folder, { recursive: true });
    return Array.from({ length: 11 }, (_, index) => join(folder, `${String(index + 1).padStart(2, "0")}.png`));
  });
  for (const path of made) {
    writeFileSync(path, "x");
    utimesSync(path, new Date(since), new Date(since));
  }
  const big = join(cwd, "big-old");
  mkdirSync(big);
  for (let index = 0; index < 514; index++) writeFileSync(join(big, `${index}.dat`), "o");
  const copy = (to: string) => `Copy-Item -Path 'source\\*.png' -Destination '${to}'`;
  const command = [...outputs.map(copy), `Push-Location -Path '${join(cwd, "launch outside task")}'`, copy("real-shots"), "Pop-Location", "Get-ChildItem -Path 'big-old' | Out-Null"].join("\n");
  const found = shellMade(command, cwd, since);
  expect(found.slice().sort()).toEqual(made.slice().sort());
  const memory = chatMemory({ record: null, messages: [{ tool: { made: found } }], cwd });
  for (const folder of [...outputs, join("launch outside task", "real-shots")]) expect(memory).toContain(`${folder} 11 (`);
  expect(memory).not.toContain("big-old");
  expect(shellMade("Get-ChildItem -Path 'big-old' | Out-Null", cwd, since)).toEqual([big]);
});

it("follows a location the command pushed and popped back", () => {
  const { cwd, shots, since } = copied();
  const task = join(cwd, "task");
  const outside = join(cwd, "launch outside task");
  const paste = join(outside, "paste");
  mkdirSync(task);
  mkdirSync(join(paste, "real-shots"), { recursive: true });
  expect(shellMade(`Push-Location -LiteralPath '${paste}'; Pop-Location; Copy-Item -Path 'x\\*.png' -Destination '../launch outside task/real-shots'`, task, since)).toEqual([join(shots, "a.png")]);
  expect(shellMade(`pushd "${paste}" && popd && cp x/*.png real-shots`, outside, since)).toEqual([join(shots, "a.png")]);
});

it("follows a folder the command left and then removed", () => {
  const { cwd, shots } = copied(0);
  const since = Date.now() + 60_000;
  const names = Array.from({ length: 11 }, (_, index) => `${String(index + 1).padStart(2, "0")}.png`);
  const made = names.map((name) => join(shots, name));
  for (const name of names) writeFileSync(join(cwd, "source", name), name);
  for (const path of made) {
    copyFileSync(join(cwd, "source", basename(path)), path);
    utimesSync(path, new Date(since), new Date(since));
  }
  const command = [
    `Set-Location -Path '${join(cwd, "launch outside task")}'`,
    "New-Item -ItemType Directory -Path 'tmp-render' | Out-Null",
    "Set-Location -Path 'tmp-render'",
    `Copy-Item -Path '${join(cwd, "source")}\\*.png' -Destination '.'`,
    "Set-Location -Path '..'",
    "Copy-Item -Path 'tmp-render\\*.png' -Destination 'real-shots'",
    "Remove-Item -LiteralPath 'tmp-render' -Recurse -Force",
  ].join("\n");
  const found = shellMade(command, cwd, since);
  expect(found.slice().sort()).toEqual(made);
  const memory = chatMemory({ record: null, messages: [{ tool: { made: found } }], cwd });
  expect(memory).toContain(`${join("launch outside task", "real-shots")} 11 (`);
});

it("finds what a recursive copy put in a new folder", () => {
  const { cwd, shots, since } = copied();
  const day = join(shots, "nested", "day1");
  mkdirSync(day, { recursive: true });
  copyFileSync(join(cwd, "source", "a.png"), join(day, "a.png"));
  expect(shellMade(`Copy-Item -Path 'source\\nested' -Recurse -Destination '${shots}'`, cwd, since).sort()).toEqual([join(shots, "a.png"), join(day, "a.png")].sort());
});

it("keeps an install or a repo the command made as its folder", () => {
  const { cwd, shots, since } = copied();
  const pkg = join(shots, "node_modules", "pkg");
  mkdirSync(pkg, { recursive: true });
  for (let index = 0; index < 512; index++) writeFileSync(join(pkg, `${index}.js`), "x");
  mkdirSync(join(shots, ".git"));
  writeFileSync(join(shots, ".git", "HEAD"), "x");
  expect(shellMade(`npm install --prefix "${shots}"`, cwd, since).sort()).toEqual([join(shots, ".git"), join(shots, "a.png"), join(shots, "node_modules")].sort());
});

const twoDestinations = [
  ["revisits an absolute folder", (one: string, two: string) => [`Set-Location -Path '${one}'; Set-Location -Path '${two}'; Set-Location -Path '${one}'`, `Set-Location -Path '${two}'`]],
  ["revisits a relative folder", () => ["Set-Location -Path 'one'; Set-Location -Path '../two'; Set-Location -Path '../one'", "Set-Location -Path '../two'"]],
  ["lists the previous folder", (one: string, two: string) => [`Set-Location -Path '${one}'`, `Set-Location -Path '${two}'; Get-ChildItem -LiteralPath '${one}' | Out-Null`]],
] as const;

it.each(twoDestinations)("reads each relative destination in the active folder when the command %s", (_, locations) => {
  const { cwd } = copied(0);
  const since = Date.now() + 60_000;
  const names = Array.from({ length: 11 }, (_, index) => `${String(index + 1).padStart(2, "0")}.png`);
  const made = ["one", "two"].flatMap((folder) => {
    mkdirSync(join(cwd, folder, "real-shots"), { recursive: true });
    return names.map((name) => join(cwd, folder, "real-shots", name));
  });
  for (const name of names) writeFileSync(join(cwd, "source", name), name);
  for (const path of made) {
    copyFileSync(join(cwd, "source", basename(path)), path);
    utimesSync(path, new Date(since), new Date(since));
  }
  const [one, two] = [join(cwd, "one"), join(cwd, "two")];
  const copy = "Copy-Item -Path '../source/*.png' -Destination 'real-shots'";
  const [first, second] = locations(one, two);
  const found = shellMade(`${first}; ${copy}; ${second}; ${copy}`, cwd, since);
  expect(found.slice().sort()).toEqual(made.slice().sort());
  const memory = chatMemory({ record: null, messages: [{ tool: { made: found } }], cwd });
  for (const folder of ["one", "two"]) expect(memory).toContain(`${join(folder, "real-shots")} 11 (`);
});
