const { nonce, port } = document.body.dataset;
window.speculationAttempts = [];
function hint(rel, host) {
  const link = document.createElement("link");
  link.rel = rel;
  link.href = `http://${host}-${nonce}.localhost:${port}/probe`;
  document.head.append(link);
  speculationAttempts.push({ rel, url: link.href });
}
hint("dns-prefetch", "dynamic-dns");
hint("preconnect", "dynamic-connect");
hint("prefetch", "dynamic-fetch");
const meta = document.createElement("meta");
meta.httpEquiv = "x-dns-prefetch-control";
meta.content = "on";
document.head.append(meta);
const dns = document.createElement("link");
dns.rel = "dns-prefetch";
dns.href = `//override-dns-${nonce}.invalid`;
document.head.append(dns);
speculationAttempts.push({ rel: "dns-prefetch-meta-on", url: dns.href });
const rules = document.createElement("script");
rules.type = "speculationrules";
rules.textContent = JSON.stringify({ prefetch: [{ source: "list", urls: [`http://speculation-${nonce}.localhost:${port}/speculation`] }] });
document.head.append(rules);
speculationAttempts.push({ rel: "speculationrules", supported: HTMLScriptElement.supports("speculationrules") });
