const host = url => { try { return new URL(url).host; } catch { return ""; } };

export function blockedGuard(rows) {
  const code = rows.find(r => ["Script", "Stylesheet"].includes(r.type) && host(r.url));
  const calls = rows.find(r => (["Fetch", "XHR", "WebSocket", "EventSource"].includes(r.type) || /^wss?:/i.test(r.url)) && host(r.url));
  return {
    scripts: code ? `code from ${host(code.url)} is blocked in the check` : calls ? `requests to ${host(calls.url)} are blocked in the check` : "",
    layout: code ? `styles from ${host(code.url)} are blocked in the check` : "",
  };
}
