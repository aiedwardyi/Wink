// Laps each step of "a host started from the copied runtime..." and ticks a watchdog into whr-phases.log.
import fs from "node:fs";
const file = "electron/worker-host-runtime.node-test.mjs";
let text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const lastImport = 'import { launchWorkerHost, stageWorkerHostRuntime, sweepWorkerHostRuntime } from "./worker-host-runtime.mjs";\n';
if (!text.includes(lastImport)) throw new Error("import anchor");
const dog = [
  'const __log = path.join(process.env.GITHUB_WORKSPACE || ".", "whr-phases.log");',
  'let __last = "start"; let __t0 = Date.now();',
  'const __lap = (n) => { __last = n; fs.appendFileSync(__log, (Date.now() - __t0) + " lap " + n + "\\n"); };',
  'const __dog = setInterval(() => fs.appendFileSync(__log, (Date.now() - __t0) + " tick last=" + __last + " res=" + process.getActiveResourcesInfo().join(",") + " lines=" + JSON.stringify((globalThis.__lines || []).slice(-3)) + " out=" + JSON.stringify(globalThis.__out ? globalThis.__out().slice(-160) : "") + "\\n"), 10_000);',
  '__dog.unref();',
].join("\n") + "\n";
text = text.replace(lastImport, () => lastImport + dog);
const head = 'test("a host started from the copied runtime runs a pane and keeps its layers"';
const a = text.indexOf(head); if (a < 0) throw new Error("test anchor");
const b = text.indexOf("\ntest(", a + 10);
const body = text.slice(a, b).split("\n").map((line, i) => {
  if (i === 0) return line + ' __t0 = Date.now(); __lap("begin");';
  let extra = "";
  if (line.trim() === "const lines = [];") extra += " globalThis.__lines = lines;";
  if (line.trim() === 'let output = "";') extra += " globalThis.__out = () => output;";
  if (/^ {2,4}\S/.test(line) && line.trimEnd().endsWith(";") && !/^\s*return\b/.test(line)) extra += " __lap(" + JSON.stringify(line.trim().slice(0, 60)) + ");";
  return line + extra;
}).join("\n");
text = text.slice(0, a) + body + text.slice(b);
fs.writeFileSync(file, text);
console.log("whr laps injected");
