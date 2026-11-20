// Makes every SQLite COMMIT on the test's thread cost 10 ms, as a busy runner's disk does.
import fs from "node:fs";
const file = process.argv[2] || "server/cold-thread.test.ts";
const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const anchor = 'afterEach(() => vi.restoreAllMocks());\n';
if (!text.includes(anchor)) throw new Error("anchor not found");
const slow = 'const __exec = DatabaseSync.prototype.exec;\nDatabaseSync.prototype.exec = function (sql: string) { if (/^\\s*COMMIT/i.test(sql)) { const end = Date.now() + 10; while (Date.now() < end); } return __exec.call(this, sql); };\n';
fs.writeFileSync(file, text.replace(anchor, () => anchor + slow));
console.log("slow commits in", file);
