import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isTest = (file) => /\.(?:test\.[^/]+|node-test\.mjs)$/.test(file);
const files = readdirSync(path.join(root, "electron"), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
  .filter((file) => !isTest(file));
const shipped = new Set([...files, "shared/error-report.mjs", "shared/update-error.mjs", "package.json"].filter((file) => !file.includes("/node_modules/")
  && !/^electron\/resources\/(?:speech-helper(?:\.swift|-Info\.plist)?$|OpenMausBot Speech\.app\/)/.test(file)
  && statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()));
// These SDK imports only load in cua.mjs when !app.isPackaged.
const allowed = new Map([["electron/cua.mjs", new Set(["@trycua/cua-driver/embedded", "@trycua/cua-driver/electron"])]]);

describe("packaged Electron imports", () => {
  it("resolves every literal import to a builtin, Electron, or a shipped file", () => {
    const failures = [];
    const modules = files.filter((file) => /\.(?:mjs|cjs)$/.test(file)).sort();
    assert.ok(modules.length > 0);
    for (const file of modules) {
      const source = readFileSync(path.join(root, file), "utf8");
      for (const { fileName: specifier, pos } of ts.preProcessFile(source, true, true).importedFiles) {
        if (isBuiltin(specifier) || specifier === "electron" || /^electron\/[^/]+$/.test(specifier)
          || allowed.get(file)?.has(specifier)) continue;
        const relative = specifier.startsWith("./") || specifier.startsWith("../");
        if (relative && shipped.has(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)))) continue;
        failures.push(`${file}:${source.slice(0, pos).split("\n").length}: ${JSON.stringify(specifier)}`);
      }
    }
    assert.equal(failures.length, 0, failures.join("\n"));
  });
});
