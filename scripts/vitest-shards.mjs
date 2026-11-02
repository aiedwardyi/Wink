// Duration-balanced vitest shards: `--shard` splits by path hash, which left one shard at 3x another.
// node scripts/vitest-shards.mjs <k> <n>          prints shard k of n, one file per line
// node scripts/vitest-shards.mjs --update <json>... rewrites the timings from CI's vitest JSON reports
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const timingsUrl = new URL("./vitest-timings.json", import.meta.url);

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : 1;
};

export function packShards(files, timings, count) {
  const fallback = median(Object.values(timings));
  const cost = (file) => timings[file] ?? fallback;
  const shards = Array.from({ length: count }, () => ({ seconds: 0, files: [] }));
  const order = [...files].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : 1));
  for (const file of order) {
    const shard = shards.reduce((low, next) => (next.seconds < low.seconds ? next : low));
    shard.seconds += cost(file);
    shard.files.push(file);
  }
  if (shards.some((shard) => !shard.files.length)) throw new Error("vitest-shards: an empty shard would run the whole suite");
  return shards;
}

// vitest treats each CLI path as a substring filter, so one path inside another would run that file twice.
export function overlappingPaths(files) {
  const lower = files.map((file) => file.toLowerCase());
  return lower.flatMap((a) => lower.filter((b) => a !== b && b.includes(a)).map((b) => `${a} in ${b}`));
}

export function timingsFromReports(reports) {
  const results = reports.flatMap((report) => report.testResults);
  const names = results.map((result) => result.name.replaceAll("\\", "/"));
  let prefix = path.posix.dirname(names[0]);
  while (!names.every((name) => name.startsWith(`${prefix}/`))) prefix = path.posix.dirname(prefix);
  // per-file setup and collection sit outside each file's own span; spread it evenly
  const wall = reports.reduce((sum, report) => sum + Math.max(...report.testResults.map((result) => result.endTime)) - report.startTime, 0);
  const spans = results.reduce((sum, result) => sum + result.endTime - result.startTime, 0);
  const overhead = (wall - spans) / results.length;
  const timings = {};
  results.forEach((result, i) => {
    timings[names[i].slice(prefix.length + 1)] = Math.round((result.endTime - result.startTime + overhead) / 100) / 10;
  });
  return Object.fromEntries(Object.entries(timings).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function vitestFiles(root) {
  const out = execFileSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "list", "--filesOnly", "--json"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return JSON.parse(out).map(({ file }) => path.relative(root, file).replaceAll("\\", "/"));
}

function main([first, ...rest]) {
  if (first === "--update") {
    const reports = rest.map((file) => JSON.parse(readFileSync(file, "utf8")));
    writeFileSync(timingsUrl, `${JSON.stringify(timingsFromReports(reports), null, 2)}\n`);
    return;
  }
  const [index, count] = [Number(first), Number(rest[0])];
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 1 || index > count) {
    throw new Error("usage: vitest-shards.mjs <k> <n> | --update <vitest-json>...");
  }
  const files = vitestFiles(fileURLToPath(new URL("../", import.meta.url)));
  const overlaps = overlappingPaths(files);
  if (overlaps.length) throw new Error(`vitest-shards: overlapping test paths: ${overlaps.join(", ")}`);
  const shards = packShards(files, JSON.parse(readFileSync(timingsUrl, "utf8")), count);
  console.log(shards[index - 1].files.join("\n"));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2));
}
