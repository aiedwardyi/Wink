// Preload for every harness run: children spawn hidden and below normal priority,
// stray errors land in a log instead of a dialog.
const { join } = require("node:path");
require(join(__dirname, "..", "..", "..", ".claude", "skills", "verify-wink", "hidden.cjs"));
const fs = require("node:fs");
const os = require("node:os");
const scratch = process.env.DESK_SCRATCH || join(process.env.TEMP || os.tmpdir(), "wink-ACCT-TRADER-O");
fs.mkdirSync(scratch, { recursive: true });
const note = (error) => fs.appendFileSync(join(scratch, "errors.log"), `${new Date().toISOString()} ${String(error && error.stack || error)}\n`);
process.on("uncaughtException", (error) => { note(error); process.exitCode = 1; });
process.on("unhandledRejection", (error) => { note(error); process.exitCode = 1; });
for (const stream of [process.stdout, process.stderr]) stream.on("error", (error) => { if (error.code !== "EPIPE") note(error); });
os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
const cp = require("node:child_process");
const spawn = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function (options) {
  const result = spawn.call(this, options);
  if (this.pid) try { os.setPriority(this.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  return result;
};
