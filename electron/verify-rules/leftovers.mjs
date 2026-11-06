export const id = "TEXT_A";
export const label = "leftovers";

export function observe({ all, visible, where }) {
  const texts = [];
  for (const n of all("body *")) {
    if (!n.matches("area[href]") && !visible(n) || n.closest("script,style,pre,code,kbd,samp,textarea,select,[contenteditable=true],[data-example]")) continue;
    const text = [...n.childNodes].filter(x => x.nodeType === Node.TEXT_NODE).map(x => x.textContent).join(" ").trim();
    const href = n.matches("a[href],area[href]") ? n.getAttribute("href").slice(0, 300) : "";
    if (text || href) texts.push({ where: where(n), text: text.slice(0, 4000), href });
  }
  return { texts };
}

export function check({ texts }) {
  const patterns = [["placeholder contact", /[\w.+-]+@(?:[\w-]+\.)*example\.(?:com|org|net)\b/i], ["lorem", /\blorem\s+ipsum\b/i], ["TODO", /\bTODO:|\bFIXME\b/], ["undefined", /\bundefined\b/], ["NaN", /\bNaN\b/]];
  const placeholderLink = /^(?:mailto:|tel:|https?:)(?:\/\/)?(?:[^/?#]*[@.])?example\.(?:com|org|net)(?=$|[/?#:])/i;
  const seen = new Set(), problems = [], checks = [];
  const add = (rule, where, measured) => { if (!seen.has(rule)) { seen.add(rule); problems.push({ rule, where, measured }); } };
  for (const row of texts) {
    if (row.example) continue;
    for (const [rule, pattern] of patterns) {
      const match = row.text.match(pattern);
      checks.push({ where: row.where, rule, bad: !!match });
      if (match) add(rule, row.where, `Unfinished copy "${match[0]}"; read this text on the page`);
    }
    if (row.href) {
      const bad = placeholderLink.test(row.href);
      checks.push({ where: row.where, rule: "placeholder contact", bad });
      if (bad) add("placeholder contact", row.where, `Link goes to placeholder "${row.href.split("?")[0]}"; open the link`);
    }
  }
  return { problems, notChecked: [], checks };
}
