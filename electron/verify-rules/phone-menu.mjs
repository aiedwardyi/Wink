export const id = "NAV";
export const label = "phone menu";

export function observe({ all, visible, where }) {
  const header = node => !!node.closest("header,[role=banner],nav,[role=navigation]");
  const pinned = node => { for (let p = node; p; p = p.parentElement) if (["fixed", "sticky"].includes(getComputedStyle(p).position)) return true; return false; };
  const links = all("a[href]").filter(n => header(n) && visible(n)).map(n => ({ href: n.getAttribute("href"), url: n.href, where: where(n) }));
  const bars = all("a[href]").filter(n => !header(n) && visible(n) && pinned(n)).map(n => ({ href: n.getAttribute("href"), url: n.href, where: where(n) }));
  const controls = all("button,[role=button],summary,label,[aria-haspopup],[aria-controls],[aria-expanded],input[type=checkbox],[class*=menu-toggle],[class*=hamburger]").filter(n => header(n) && visible(n));
  const menu = controls.some(n => {
    if (n.matches("summary")) return !!n.parentElement?.querySelector("a[href]");
    if (n.matches("label")) return document.getElementById(n.htmlFor)?.matches("input[type=checkbox]") || !!n.querySelector("input[type=checkbox]");
    return n.matches("input[type=checkbox]") || n.hasAttribute("aria-controls") || n.hasAttribute("aria-expanded") || /menu|navigation|toggle|hamburger|메뉴|탐색/i.test(`${n.textContent} ${n.getAttribute("aria-label")} ${n.id} ${n.className}`);
  });
  const cssMenu = [...document.styleSheets].some(sheet => {
    let rules;
    try { rules = sheet.cssRules; } catch { return false; }
    const usable = rules => [...rules].some(rule => {
      if (rule.cssRules?.length) return usable(rule.cssRules);
      if (!rule.selectorText || !/:(hover|focus-within)/.test(rule.selectorText)) return false;
      return rule.selectorText.split(",").some(selector => {
        const trigger = selector.split(/:(?:hover|focus-within)/)[0].trim();
        try { return all(trigger).some(n => header(n) && visible(n) && n.querySelectorAll("a[href]").length >= 2); } catch { return false; }
      });
    });
    return usable(rules);
  });
  return { links, bars, menu: menu || cssMenu };
}

export function check(phone, desktop) {
  const key = a => a.url ?? a.href;
  const reachable = new Set(phone.links.map(key));
  const lost = [...new Map(desktop.links.map(a => [key(a), a.href])).entries()].filter(([url]) => !reachable.has(url));
  const bar = new Set((phone.bars ?? []).map(key));
  const replaced = lost.filter(([url]) => bar.has(url)).length >= 2;
  return { problems: lost.length >= 2 && !phone.menu && !replaced ? [{ rule: "phone menu gone", where: "header nav", measured: `${lost.slice(0, 5).map(([, href]) => href).join(", ")} disappear at 392 px with no menu control; narrow the page` }] : [], notChecked: [] };
}
