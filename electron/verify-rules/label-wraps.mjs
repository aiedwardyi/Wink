export const id = "FIT";
export const label = "label wraps";

export function observe({ all, visible, where }) {
  const rows = [], range = document.createRange();
  const lines = () => {
    const tops = [];
    for (const r of [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0).sort((a, b) => a.top - b.top)) {
      if (!tops.length || r.top >= tops.at(-1) + r.height / 2) tops.push(r.top);
    }
    return tops.length;
  };
  for (const node of all("body *")) {
    if (!visible(node) || node.closest("script,style,pre,code,kbd,samp,textarea,select,svg,[contenteditable=true]") || getComputedStyle(node).whiteSpace.startsWith("pre")) continue;
    for (const child of node.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE || !child.textContent.trim()) continue;
      range.selectNodeContents(child);
      const count = lines();
      if (count < 2) continue;
      const control = node.closest("a[href],button,[role=button],[role=tab],[role=menuitem],summary,label");
      const text = (control ?? node).textContent.replace(/\s+/g, " ").trim();
      let split = "";
      for (const match of child.textContent.matchAll(/\S{2,}/g)) {
        range.setStart(child, match.index); range.setEnd(child, match.index + match[0].length);
        if (lines() > 1) { split = match[0]; break; }
      }
      const box = (control ?? node).getBoundingClientRect();
      rows.push({ where: where(control ?? node), text: text.slice(0, 80), length: text.length, words: text ? text.split(" ").length : 0, lines: count, control: !!control, split: split.slice(0, 40), box: [box.x, box.y, box.width, box.height], scrollY });
    }
  }
  return { rows };
}

export function check({ rows }) {
  const problems = new Map();
  for (const row of rows) {
    const word = row.split && row.length <= 40 && row.words <= 3, short = row.control && row.length <= 24 && row.words <= 3;
    if (!word && !short) continue;
    const measured = word ? `"${row.text}" breaks inside "${row.split}"; keep it on one line` : `"${row.text}" on ${row.lines} lines; keep the label on one line`;
    problems.set(`${row.where}\n${measured}\n${row.box}`, { rule: "label wraps", where: row.where, measured, box: row.box, value: row.lines });
  }
  return { problems: [...problems.values()], notChecked: [] };
}
