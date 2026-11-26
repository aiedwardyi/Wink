import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { missingAssets, referencedAssets } from "./check-packaged-assets.mjs";

const temporaryDirectories = [];

function ui(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-packaged-assets-"));
  temporaryDirectories.push(root);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("packaged UI assets", () => {
  // the 1.0.304 shape: a What's New clip the bundle asks for, absent from the tree
  const built = {
    "index.html": '<script type="module" src="/assets/index-AbC.js"></script><link rel="stylesheet" href="/assets/index-DeF.css">',
    "assets/index-AbC.js": 'const clip="/assets/1.0.304-quick-qvheZUkJ.mp4";new Worker(new URL("assets/map-Gh1.js",import.meta.url));const s="myassets/not-a-ref.png";',
    "assets/index-DeF.css": "@font-face{src:url(/assets/inter-Jk2.woff2)}",
    "assets/map-Gh1.js": "",
    "assets/inter-Jk2.woff2": "",
  };

  it("collects what index.html, the bundles and the stylesheets reference", () => {
    expect(referencedAssets(ui(built))).toEqual(["1.0.304-quick-qvheZUkJ.mp4", "index-AbC.js", "index-DeF.css", "inter-Jk2.woff2", "map-Gh1.js"]);
  });

  it("names a referenced clip that did not ship", () => {
    expect(missingAssets(ui(built))).toEqual(["1.0.304-quick-qvheZUkJ.mp4"]);
  });

  it("passes once every referenced file is there", () => {
    expect(missingAssets(ui({ ...built, "assets/1.0.304-quick-qvheZUkJ.mp4": "" }))).toEqual([]);
  });
});
