// The release refuses a version without its own What's New entry: unseenRelease skips newer entries, so the update would show the last notes again.
// The entry is either tiles or an explicit no-tile record: tile: "none" with a reason.
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

function entryText(source, version) {
  const start = source.search(new RegExp(`^ {2}"${version.replaceAll(".", "\\.")}": \\{`, "m"));
  if (start < 0) return null;
  const rest = source.slice(start + 1);
  const end = rest.search(/^ {2}"\d+\.\d+\.\d+": \{|^\};/m);
  return end < 0 ? rest : rest.slice(0, end);
}

const decided = (text) => /\btiles:\s*\[/.test(text) || (/\btile:\s*"none"/.test(text) && /\breason:\s*"[^"]+"/.test(text));

export function whatsNewGap(source, version) {
  const entries = whatsNewVersions(source);
  const text = entryText(source, version);
  if (text !== null) return decided(text) ? null : `What's New ${version} has neither a tile nor a no-tile record: add tiles, or tile: "none" with a reason`;
  const shown = entries.filter((entry) => older(entry, version)).sort((a, b) => (older(a, b) ? 1 : -1))[0] ?? "no notes";
  return `What's New has no ${version} entry, so ${version} would show ${shown}: add a "${version}" entry to RELEASE_NOTES in src/lib/whats-new.ts`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const gap = whatsNewGap(readFileSync(join(root, "src/lib/whats-new.ts"), "utf8"), version);
  console.log(gap ?? `What's New covers ${version}`);
  process.exit(gap ? 1 : 0);
}
