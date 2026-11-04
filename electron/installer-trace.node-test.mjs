import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../build/installer.nsh", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const macro = (name) => source.match(new RegExp(`!macro ${name}\\b[\\s\\S]*?!macroend`))?.[0] ?? "";

test("installer records init, check boundaries and ready on updates", () => {
  assert.match(macro("customInit"), /\$\{if\} \$\{isUpdated\}\s+!insertmacro winkUpdateTrace "init"/);
  assert.match(macro("customInstall"), /DeleteRegValue[^\n]+\n\s+!insertmacro winkUpdateTrace "ready"/);
  const check = macro("customCheckAppRunning");
  assert.match(check, /!insertmacro winkUpdateTrace "check-begin"/);
  assert.match(check, /!insertmacro winkFindInstallProcesses 0\s+!ifndef BUILD_UNINSTALLER\s+StrCpy \$R2 \$R0/);
  assert.match(check, /IntOp \$R1 \$R1 \+ 1\s+!ifndef BUILD_UNINSTALLER\s+IntOp \$R3 \$R3 \+ 1/);
  assert.match(check, /!insertmacro winkUpdateTrace "check-end" "\$R2" "\$R3"/);
});

test("installer writer is bounded, update-only and preserves registers and errors", () => {
  const trace = macro("winkUpdateTrace");
  assert.match(trace, /!ifndef BUILD_UNINSTALLER[\s\S]*?Push \$R9[\s\S]*?\$\{Errors\}[\s\S]*?\$\{if\} \$\{isUpdated\}\s+Push \$0/);
  assert.match(trace, /ReadEnvStr \$0 "APPDATA"/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(trace.includes(`$0\\${pkg.name}\\logs`));
  assert.match(trace, /FileSeek \$1 0 END \$3/);
  assert.match(trace, /\$3 <= 1048576/);
  assert.match(trace, /GetSystemTimeAsFileTime\(\*l \.r2\)/);
  assert.match(trace, /utcFileTime=\$2/);
  assert.match(trace, /StrCpy \$R4 0\s+\$\{if\} \$\{Errors\}\s+StrCpy \$R4 1/);
  assert.match(trace, /\$\{if\} \$R4 == 1\s+SetErrors\s+\$\{else\}\s+ClearErrors/);
  const pushed = [...trace.matchAll(/Push (\$\w+)/g)].map((m) => m[1]);
  const popped = [...trace.matchAll(/Pop (\$\w+)/g)].map((m) => m[1]);
  assert.deepEqual(popped, pushed.toReversed());
  assert.doesNotMatch(trace, /CreateDirectory|SetShellVarContext|\bVar\b|\bFunction\b|Exec(?:Wait|Shell)?\b/);
  assert.doesNotMatch(trace, /^\s*(?!System::)\w+::/m);
  assert.equal((trace.match(/FileWrite /g) ?? []).length, 1);
  assert.match(trace, /FileWrite \$1 "\$4\$\\r\$\\n"/);
  for (const field of ["version", "pid", "silent", "forcerun", "admin", "runonce", "first", "loops", "launch", "exe", "menu", "desktop", "keepShortcuts", "shell", "startapp"]) assert.ok(trace.includes(`${field}=`), field);
});

test("installer retains process checks, RunOnce recovery and dialog jumps", () => {
  const trace = macro("winkUpdateTrace");
  const original = (trace ? source.replace(`${trace}\n\n`, "") : source).replace(/!ifndef BUILD_UNINSTALLER\n[\s\S]*?!endif\n/g, "").replace(/^ +!insertmacro winkUpdateTrace[^\n]+\n/gm, "");
  assert.equal(createHash("sha256").update(original).digest("hex"), "7687e3beb1a626b09701ff8d9a9d4898c706487e7104a00a6b9a7a6ed49a45cf");
  assert.equal(createHash("sha256").update(macro("winkFindInstallProcesses")).digest("hex"), "314e69d6bad94205612a9a8fbe9abbd7ae38c5f8fcc530931ffa658a741590b2");
  assert.ok(source.includes('WriteRegStr HKCU "${UPDATE_RUN_ONCE_KEY}" "${UPDATE_RUN_ONCE_NAME}" \'"$EXEPATH" --updated /S --force-run /D=$INSTDIR\''));
  assert.equal((source.match(/MessageBox[^\n]+\+2\n\s+Quit/g) ?? []).length, 2);
  assert.doesNotMatch(source, /^(?:Var|Function)\b/m);
});

test("ready predicts the template's one-click and assisted launch predicates", () => {
  assert.match(macro("winkUpdateTrace"), /!ifdef ONE_CLICK\s+!ifdef RUN_AFTER_FINISH\s+\$\{ifNot\} \$\{Silent\}\s+\$\{orIf\} \$\{isForceRun\}\s+StrCpy \$9 1[\s\S]*?!else\s+\$\{if\} \$\{isForceRun\}\s+StrCpy \$9 1[\s\S]*?!else\s+\$\{if\} \$\{isForceRun\}\s+\$\{andIf\} \$\{Silent\}\s+StrCpy \$9 1/);
});
