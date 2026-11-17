// The release refuses a version whose What's New is older: without an entry, an update shows the last notes again under their old version.
// Plain node, no install: release.yml runs it in the prepare job.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const older = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

export function whatsNewGap(source, version) {
  const entries = [...source.matchAll(/^ {2}"(\d+\.\d+\.\d+)": \{/gm)].map((match) => match[1]);
  const newest = entries.reduce((a, b) => (older(a, b) ? b : a), "0.0.0");
  return older(newest, version) ? `What's New is ${newest}, older than ${version}: add a "${version}" entry to WHATS_NEW in src/lib/whats-new.ts` : null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const gap = whatsNewGap(readFileSync(join(root, "src/lib/whats-new.ts"), "utf8"), version);
  console.log(gap ?? `What's New covers ${version}`);
  process.exit(gap ? 1 : 0);
}
