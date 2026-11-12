import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const CMAPS = join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "cmaps");

/** pdf.js fetches CMaps by name, so they ship unhashed under /pdfjs/cmaps/. */
export function pdfjsData() {
  return {
    name: "pdfjs-data",
    configureServer(server) {
      server.middlewares.use("/pdfjs/cmaps", (req, res, next) => {
        const name = (req.url ?? "").split("?")[0].slice(1);
        if (!/^[\w-]+\.bcmap$/.test(name)) return next();
        try {
          res.end(readFileSync(join(CMAPS, name)));
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const name of readdirSync(CMAPS)) this.emitFile({ type: "asset", fileName: `pdfjs/cmaps/${name}`, source: readFileSync(join(CMAPS, name)) });
    },
  };
}
