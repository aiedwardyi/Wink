// Every file the built UI asks for under /assets must ship. electron-builder
// only warns when a copy goes wrong, and a missing clip or font shows up as a
// blank tile in the installed app, not as a build error.
//
//   node scripts/check-packaged-assets.mjs release/win-unpacked/resources dist
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// "/assets/x-Hash.mp4", "assets/x.js" and url(/assets/x.woff2): Vite's three spellings
const REFERENCE = /(?<![\w.-])\/?assets\/([\w.-]+\.[A-Za-z0-9]+)/g;

export function referencedAssets(uiDir) {
  const assets = path.join(uiDir, "assets");
  const sources = [path.join(uiDir, "index.html")];
  if (existsSync(assets)) {
    for (const name of readdirSync(assets)) if (/\.(?:js|mjs|css|html)$/.test(name)) sources.push(path.join(assets, name));
  }
  const names = new Set();
  for (const source of sources) {
    for (const match of readFileSync(source, "utf8").matchAll(REFERENCE)) names.add(match[1]);
  }
  return [...names].sort();
}

export function missingAssets(uiDir) {
  return referencedAssets(uiDir).filter((name) => !existsSync(path.join(uiDir, "assets", name)));
}

// Lazy chunks (Shiki grammars, views) are reached by "./x.js" imports the scan
// above does not follow, so every file Vite built must ship as well.
export function unshippedAssets(uiDir, builtDir) {
  return readdirSync(path.join(builtDir, "assets")).filter((name) => !existsSync(path.join(uiDir, "assets", name))).sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [resources, built] = process.argv.slice(2);
  if (!resources) {
    console.error("usage: check-packaged-assets.mjs <packaged resources dir> [built dist dir]");
    process.exit(2);
  }
  const ui = path.join(resources, "ui");
  const assets = path.join(ui, "assets");
  const index = path.join(ui, "index.html");
  // an empty tree must not pass as "all 0 assets are there"
  if (!existsSync(index)) fail(`${index} is missing`);
  if (!existsSync(assets) || !readdirSync(assets).length) fail(`${assets} has no files, so the packaged UI shipped no assets`);
  const referenced = referencedAssets(ui);
  if (!referenced.length) fail(`${index} and its bundles reference no files under /assets: a truncated index.html or a renamed assetsDir`);
  const errors = referenced.filter((name) => !existsSync(path.join(assets, name))).map((name) => `the built UI references assets/${name} but ${path.join(assets, name)} is missing`);
  if (built) errors.push(...unshippedAssets(ui, built).map((name) => `${path.join(built, "assets", name)} was built but ${path.join(assets, name)} is missing`));
  for (const error of errors) console.error(`::error::${error}`);
  if (errors.length) process.exit(1);
  console.log(`all ${referenced.length} assets the built UI references${built ? ` and every file in ${path.join(built, "assets")}` : ""} are in ${ui}`);
}

function fail(error) {
  console.error(`::error::${error}`);
  process.exit(1);
}
