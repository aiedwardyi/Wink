// The tab Google lands on after sign-in. Self-contained: it is served from a loopback port with no other assets.
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const LOGO =
  '<svg class="logo" width="48" height="48" viewBox="0 0 256 256" role="img" aria-label="Wink"><defs><linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f2747"/><stop offset="1" stop-color="#0a0e19"/></linearGradient></defs><rect x="12" y="12" width="232" height="232" rx="54" fill="url(#tile)" stroke="#323b5c" stroke-width="3"/><path d="M72 86 L122 128 L72 170" fill="none" stroke="#ff4d9d" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/><rect x="146" y="156" width="52" height="28" rx="14" fill="#ffd447"/></svg>';

// Colors and type match site/signin/signin.css.
const STYLE = `:root{color-scheme:light dark;--app:#eeebf7;--ink:#1f2747;--ink-secondary:#545b7c;--accent:#b91a61}
@media(prefers-color-scheme:dark){:root{--app:#121316;--ink:#eeeff3;--ink-secondary:#a3a7b3;--accent:#929fff}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--app);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif;word-break:keep-all;overflow-wrap:anywhere}
main{display:grid;place-items:center;min-height:100vh;padding:24px 16px}
.panel{width:100%;max-width:360px;text-align:center}
a{display:inline-block;margin-top:16px;color:var(--accent);font-size:13px}
.logo{display:block;margin:0 auto 16px}
h1{margin:0 0 6px;font-size:20px;font-weight:600;letter-spacing:-.02em}
p{margin:0;color:var(--ink-secondary);font-size:13px}`;

export const DASHBOARD_URL = "https://app.getwink.dev/";

export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/** `next` = { url, label }: meta refresh needs no script, so the CSP stays script-free. */
export function signInPage({ locale = "en", title, body = "", next }) {
  const text = body ? `<p>${escapeHtml(body)}</p>` : "";
  const link = next ? `<a href="${escapeHtml(next.url)}">${escapeHtml(next.label)}</a>` : "";
  const refresh = next ? `<meta http-equiv="refresh" content="1;url=${escapeHtml(next.url)}">` : "";
  return `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8">${refresh}<meta name="viewport" content="width=device-width,initial-scale=1"><title>Wink</title><style>${STYLE}</style></head><body><main><div class="panel">${LOGO}<h1>${escapeHtml(title)}</h1>${text}${link}</div></main></body></html>`;
}
