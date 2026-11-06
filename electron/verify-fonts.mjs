import dns from "node:dns";
import https from "node:https";

const hosts = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
const fontTypes = new Set(["font/woff2", "font/woff", "font/ttf", "font/otf", "application/font-woff"]);

function fontUrl(raw, host) {
  try { const url = new URL(raw); return url.protocol === "https:" && url.hostname === host && !url.port && !url.username && !url.password && !url.hash && raw === url.href && raw.length <= 4096; }
  catch { return false; }
}

export function createVerifyFonts({ fontUrls, logLookup = () => {}, request = https.request, lookup = dns.lookup }) {
  const sheets = new Set(fontUrls.filter((url) => fontUrl(url, "fonts.googleapis.com") && /^\/css2?$/.test(new URL(url).pathname)));
  const fonts = new Set();
  const cache = new Map();
  const pending = new Set();
  let total = 0;
  let closed = false;
  const allowed = (raw) => sheets.has(raw) || fonts.has(raw);
  function fetchFont(raw) {
    return new Promise((resolve, reject) => {
      const sheet = sheets.has(raw);
      const cap = sheet ? 128 * 1024 : 2 * 1024 * 1024;
      let timer;
      let req;
      const finish = (err, value) => { clearTimeout(timer); pending.delete(req); if (err) reject(err); else resolve(value); };
      try {
        req = request(raw, { method: "GET", headers: {}, agent: false, lookup(name, options, callback) {
          if (!hosts.has(name)) { callback(new Error("Font lookup denied")); return; }
          logLookup(name);
          lookup(name, options, callback);
        } }, (res) => {
          const type = String(res.headers["content-type"] ?? "").split(";")[0].toLowerCase();
          if (res.statusCode !== 200 || (sheet ? type !== "text/css" : !fontTypes.has(type)) || Number(res.headers["content-length"] ?? 0) > cap) { res.destroy(); req.destroy(); finish(new Error("Font response denied")); return; }
          const chunks = [];
          let bytes = 0;
          res.on("error", (err) => finish(err));
          res.on("data", (chunk) => {
            bytes += chunk.length; total += chunk.length;
            if (bytes > cap || total > 8 * 1024 * 1024 || closed) { res.destroy(); req.destroy(); finish(new Error("Font byte cap")); return; }
            chunks.push(chunk);
          });
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            if (sheet) {
              for (const match of body.toString("utf8").matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)) {
                if (!fontUrl(match[1], "fonts.gstatic.com") || fonts.size >= 512) { finish(new Error("Font CSS URL denied")); return; }
                fonts.add(match[1]);
              }
            }
            finish(null, { body, type });
          });
        });
        pending.add(req);
        req.once("error", (err) => finish(err));
        // req emits no error once a response exists, so every cutoff settles itself.
        timer = setTimeout(() => { req.destroy(); finish(new Error("Font request timeout")); }, 5000);
        req.end();
      } catch (err) { finish(err); }
    });
  }
  return {
    allowed,
    async handle(req) {
      if (closed || req.method !== "GET" || !allowed(req.url)) return new Response(null, { status: 403 });
      try {
        if (!cache.has(req.url)) cache.set(req.url, fetchFont(req.url));
        const { body, type } = await cache.get(req.url);
        return new Response(body, { status: 200, headers: { "content-type": type, "cache-control": "no-store", "access-control-allow-origin": "*" } });
      } catch { return new Response(null, { status: 403 }); }
    },
    close() { closed = true; for (const req of pending) req.destroy(new Error("Font handler closed")); pending.clear(); cache.clear(); fonts.clear(); },
  };
}
