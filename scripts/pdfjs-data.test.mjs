import { describe, expect, it } from "vitest";
import { pdfjsData } from "./pdfjs-data.mjs";

const serve = (url) => new Promise((resolve) => {
  let handler;
  pdfjsData().configureServer({ middlewares: { use: (_path, fn) => { handler = fn; } } });
  handler({ url }, { end: (body) => resolve(body) }, () => resolve(null));
});

describe("pdf.js CMaps", () => {
  it("ship unhashed under pdfjs/cmaps/", () => {
    const files = [];
    pdfjsData().generateBundle.call({ emitFile: (file) => files.push(file) });
    expect(files.map((file) => file.fileName)).toContain("pdfjs/cmaps/UniKS-UCS2-H.bcmap");
    expect(files.every((file) => file.type === "asset" && file.source.length > 0)).toBe(true);
  });

  it("are served in dev, and nothing else is", async () => {
    expect((await serve("/UniKS-UCS2-H.bcmap?v=1"))?.length).toBeGreaterThan(0);
    expect(await serve("/../package.json")).toBeNull();
    expect(await serve("/..%2Fpackage.json")).toBeNull();
    expect(await serve("/nope.bcmap")).toBeNull();
  });
});
