// Adds 0.1 ms to every SQLite statement run in the reply-activity test, as a starved runner does.
import fs from "node:fs";
const file = "server/reply-activity.test.ts";
const text = fs.readFileSync(file, "utf8");
const slow = 'import { StatementSync } from "node:sqlite";\nconst __run = StatementSync.prototype.run;\nStatementSync.prototype.run = function (...args: unknown[]) { const end = performance.now() + 0.1; while (performance.now() < end); return __run.apply(this, args as never); };\n';
fs.writeFileSync(file, slow + text);
console.log("slow statement runs in", file);
