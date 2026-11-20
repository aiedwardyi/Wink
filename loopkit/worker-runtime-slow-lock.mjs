// Usage: node red-b.mjs <worker-host-runtime.node-test.mjs>
// Holds the ended host's lock for 1.5 s after its pid is gone, as Windows can while the process runs down.
import fs from "node:fs";
const file = "electron/worker-host-runtime.node-test.mjs";
const text = fs.readFileSync(file, "utf8");
const anchor = "  await pane.exited;\n  client.close();\n";
if (!text.includes(anchor)) throw new Error("anchor not found");
const hold = '  { const { spawn } = await import("node:child_process"); await until(() => !alive(hosts[0])); const held = spawn(process.execPath, ["-e", \'const fs = require("fs"); for (;;) { try { fs.openSync(process.argv[1], fs.constants.O_RDWR | 0x10000000); break; } catch {} } console.log("held"); setTimeout(() => {}, 1500);\', path.join(root, "data", "v1", "host.lock")], { windowsHide: true }); await new Promise((resolve) => held.stdout.once("data", resolve)); }\n';
fs.writeFileSync(file, text.replace(anchor, anchor + hold));
console.log("injected", file);
