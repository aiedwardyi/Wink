import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

// what the workflows run: node scripts/check-packaged-assets.mjs <resources> [dist]
function check(...args) {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("./check-packaged-assets.mjs", import.meta.url)), ...args], { encoding: "utf8", windowsHide: true });
  return { status: run.status, output: run.stdout + run.stderr };
}

// files under resources/ui, the way electron-builder lays them out
function resources(files) {
  return ui(Object.fromEntries(Object.entries(files).map(([name, body]) => [path.join("ui", name), body])));
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

  describe("from the command line", () => {
    const shipped = { ...built, "assets/1.0.304-quick-qvheZUkJ.mp4": "" };

    it("passes a full tree and fails one missing a referenced clip", () => {
      expect(check(resources(shipped))).toMatchObject({ status: 0 });
      const result = check(resources(built));
      expect(result.status).toBe(1);
      expect(result.output).toContain("assets/1.0.304-quick-qvheZUkJ.mp4");
    });

    it("fails an empty tree instead of passing with 0 assets", () => {
      const result = check(resources({ "index.html": "" }));
      expect(result.status).toBe(1);
      expect(result.output).toMatch(/assets has no files/);
    });

    it("fails when index.html and the bundles reference nothing", () => {
      const result = check(resources({ "index.html": "<!doctype html>", "assets/map-Gh1.js": "", "assets/inter-Jk2.woff2": "" }));
      expect(result.status).toBe(1);
      expect(result.output).toMatch(/index\.html and its bundles reference no files/);
    });

    it("fails when a file in dist/assets did not ship", () => {
      const dist = ui({ ...shipped, "assets/html-BW_6VhB7.js": "" });
      expect(check(resources(shipped), dist)).toMatchObject({ status: 1, output: expect.stringContaining("html-BW_6VhB7.js") });
      expect(check(resources(shipped), ui(shipped))).toMatchObject({ status: 0 });
    });
  });
});
