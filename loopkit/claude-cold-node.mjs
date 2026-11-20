import { readFileSync, writeFileSync } from "node:fs";
// Red recipe: any node started from %ProgramFiles%\nodejs takes 9 s to start, like a cold first start on a runner.
const file = "server/procs.ts";
const anchor = 'const launch = accountLaunch(account, accountDriver ?? "", resolved.args, options.env ?? process.env);';
const src = readFileSync(file, "utf8");
if (!src.includes(anchor)) throw new Error("anchor missing");
const inject = 'if (resolved.command.startsWith(join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs"))) launch.args.unshift("--import=data:text/javascript," + encodeURIComponent("await new Promise((r) => setTimeout(r, 9000))"));';
writeFileSync(file, src.replace(anchor, anchor + "\n  " + inject));
if (!/^import .*\bjoin\b.* from "node:path";/m.test(src)) throw new Error("procs.ts has no join import");
