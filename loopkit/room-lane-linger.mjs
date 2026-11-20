import fs from "node:fs";
const sub = (file, from, to) => { const s = fs.readFileSync(file, "utf8"); if (!s.includes(from)) throw new Error("anchor missing in " + file + ": " + from); fs.writeFileSync(file, s.replace(from, () => to)); };
sub("server/procs.ts", "...(process.platform === \"win32\" ? { windowsHide: true } : { detached: true }),", "...(process.platform === \"win32\" ? { windowsHide: true, detached: Boolean(process.env.LOOP_LINGER_MS) } : { detached: true }),");
const fake = fs.readFileSync("server/testing/fake-claude-cli.ts", "utf8").split("\n");
fake.splice(fake.findLastIndex((l) => /^import /.test(l)) + 1, 0, "if (process.env.LOOP_LINGER_MS) { const exit = process.exit.bind(process); const keep = setInterval(() => {}, 1_000); (process as any).exit = (code?: number) => { setTimeout(() => { clearInterval(keep); exit(code); }, Number(process.env.LOOP_LINGER_MS)); }; process.stdin.on(\"end\", () => (process as any).exit(0)); }");
fs.writeFileSync("server/testing/fake-claude-cli.ts", fake.join("\n"));
sub("server/room-lane.e2e.test.ts", "environment: { FAKE_CLAUDE_HOLD_DIR: holds, FAKE_CLAUDE_PROMPT_LOG: prompts, ...environment },", 'environment: { FAKE_CLAUDE_HOLD_DIR: holds, FAKE_CLAUDE_PROMPT_LOG: prompts, LOOP_LINGER_MS: "3000", ...environment },');
sub("server/room-lane.e2e.test.ts", '      OMB_TERMINAL_TOKEN: "room-lane-test",', '      OMB_TERMINAL_TOKEN: "room-lane-test",\n      LOOP_LINGER_MS: "3000",');
console.log("applied room-lane linger");
