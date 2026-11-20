// Laps each deferred cleanup step into whr-phases.log.
import fs from "node:fs";
const file = "electron/node-test-cleanup.mjs";
let text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const a = "        try { await run(); } catch (error) { errors.push(error); }\n";
if (!text.includes(a)) throw new Error("cleanup anchor");
text = text.replace(a, () => '        const __s = Date.now(); const __n = String(run).slice(0, 70); try { (await import("node:fs")).appendFileSync("whr-phases.log", "cleanup start " + __n + "\\n"); } catch {}\n' + a + '        try { (await import("node:fs")).appendFileSync("whr-phases.log", "cleanup end " + (Date.now() - __s) + " ms " + __n + " " + (errors.length ? String(errors.at(-1)).slice(0, 160) : "") + "\\n"); } catch {}\n');
fs.writeFileSync(file, text);
console.log("cleanup laps injected");
