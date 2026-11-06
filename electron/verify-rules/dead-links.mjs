export const id = "LINKS";
export const label = "links";

export function observe({ all, visible, where }) {
  const links = all("a[href]").filter(visible);
  if (links.length > 300) throw new Error("resource-limit");
  return { links: links.map(a => {
    const href = a.getAttribute("href"), url = new URL(a.href, location.href);
    const samePage = url.origin === location.origin && url.pathname === location.pathname && url.search === location.search;
    let target;
    try { target = url.hash ? document.getElementById(decodeURIComponent(url.hash.slice(1))) || document.getElementsByName(decodeURIComponent(url.hash.slice(1)))[0] : null; } catch {}
    return { where: where(a), href, url: url.href, samePage, local: url.origin === location.origin && /^https?:$/.test(url.protocol),
      missing: samePage && url.hash.length > 1 && !target,
      nowhere: ["", "#"].includes(href.trim()),
      registration: /(?:sign[ -]?up|register|apply|신청|등록|가입)/i.test(a.textContent),
      self: samePage && !!target && (target === a || target.contains(a)),
      collects: !!target?.querySelector("input:not([type=hidden]),textarea,select,form,a[href]:not([href^='#'])"),
      action: a.hasAttribute("aria-controls") || a.hasAttribute("aria-expanded") || a.getAttribute("role") === "tab" };
  }) };
}

export function check({ links }) {
  const problems = [], notChecked = [];
  let nowhere = 0;
  for (const a of links) {
    let rule, measured;
    if (a.nowhere && !(a.registration && !a.action)) nowhere++;
    else if (a.nowhere) { rule = "self sign-up"; measured = `Sign-up link "${a.href}" goes nowhere; click the link`; }
    else if (a.missing) { rule = "missing target"; measured = `${a.href} has no target; click the link`; }
    else if (a.status === 404) { rule = "local 404"; measured = `${a.href} returns 404; click the link`; }
    else if (a.registration && a.self && !a.collects && !a.action) { rule = "self sign-up"; measured = `${a.href} points at its own sign-up control or section without a collection destination; click the link`; }
    if (rule) problems.push({ rule, where: a.where, measured });
    if (a.unchecked) notChecked.push(`link: ${a.where}`);
  }
  if (links.some(a => !a.local && /^https?:/.test(a.url ?? ""))) notChecked.push("external links");
  return { problems, notChecked, details: nowhere ? [{ rule: "links go nowhere", where: "page", measured: `${nowhere} ${nowhere === 1 ? "link goes" : "links go"} nowhere` }] : [] };
}
