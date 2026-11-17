// The release refuses a version without its own What's New entry: unseenRelease skips newer entries, so the update would show the last notes again.
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

export const whatsNewVersions = (source) => [...source.matchAll(/^ {2}"(\d+\.\d+\.\d+)": \{/gm)].map((match) => match[1]);

export function whatsNewGap(source, version) {
  const entries = whatsNewVersions(source);
  if (entries.includes(version)) return null;
  const shown = entries.filter((entry) => older(entry, version)).sort((a, b) => (older(a, b) ? 1 : -1))[0] ?? "no notes";
  return `What's New has no ${version} entry, so ${version} would show ${shown}: add a "${version}" entry to WHATS_NEW in src/lib/whats-new.ts`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const gap = whatsNewGap(readFileSync(join(root, "src/lib/whats-new.ts"), "utf8"), version);
  console.log(gap ?? `What's New covers ${version}`);
  process.exit(gap ? 1 : 0);
}
