#!/usr/bin/env node
// Every file the built UI asks for under /assets must ship. electron-builder
// only warns when a copy goes wrong, and a missing clip or font shows up as a
// blank tile in the installed app, not as a build error.
//
//   node scripts/check-packaged-assets.mjs release/win-unpacked/resources
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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const resources = process.argv[2];
  if (!resources) {
    console.error("usage: check-packaged-assets.mjs <packaged resources dir>");
    process.exit(2);
  }
  const ui = path.join(resources, "ui");
  const referenced = referencedAssets(ui);
  const missing = missingAssets(ui);
  for (const name of missing) console.error(`::error::the built UI references assets/${name} but ${path.join(ui, "assets", name)} is missing`);
  if (missing.length) process.exit(1);
  console.log(`all ${referenced.length} assets the built UI references are in ${ui}`);
}
