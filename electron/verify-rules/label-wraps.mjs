export const id = "FIT";
export const label = "label wraps";

export function observe({ all, visible, where }) {
  const rows = [], range = document.createRange(), controls = new Map();
  const rects = (text, start = 0, end = text.textContent.length) => { range.setStart(text, start); range.setEnd(text, end); return [...range.getClientRects()]; };
  const lines = list => {
    const tops = [];
    for (const r of list.filter(r => r.width > 0 && r.height > 0).sort((a, b) => a.top - b.top)) {
      if (!tops.length || r.top >= tops.at(-1) + r.height / 2) tops.push(r.top);
    }
    return tops.length;
  };
  const push = (element, texts, count, control) => {
    let split = "";
    for (const text of texts) for (const match of text.textContent.matchAll(/\S{2,}/g)) {
      if (!split && lines(rects(text, match.index, match.index + match[0].length)) > 1) split = match[0];
    }
    const text = element.textContent.replace(/\s+/g, " ").trim(), box = element.getBoundingClientRect();
    rows.push({ where: where(element), text: text.slice(0, 80), length: text.length, words: text ? text.split(" ").length : 0, lines: count, control, split: split.slice(0, 40), box: [box.x, box.y, box.width, box.height], scrollY });
  };
  for (const node of all("body *")) {
    if (!visible(node) || node.closest("script,style,pre,code,kbd,samp,textarea,select,svg,[contenteditable=true]") || getComputedStyle(node).whiteSpace.startsWith("pre")) continue;
    const control = node.closest("a[href],button,[role=button],[role=tab],[role=menuitem],summary,label");
    for (const child of node.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE || !child.textContent.trim()) continue;
      if (control) {
        let block = node;
        while (block !== control && ["inline", "contents"].includes(getComputedStyle(block).display)) block = block.parentElement;
        const blocks = controls.get(control) ?? controls.set(control, new Map()).get(control);
        blocks.set(block, [...blocks.get(block) ?? [], child]);
        continue;
      }
      const count = lines(rects(child));
      if (count > 1) push(node, [child], count, false);
    }
  }
  // A label can wrap between its text nodes (<button>Sign <span>Out</span></button>), so count lines per block, not per node.
  for (const [control, blocks] of controls) {
    const count = Math.max(...[...blocks.values()].map(texts => lines(texts.flatMap(text => rects(text)))));
    if (count > 1) push(control, [...blocks.values()].flat(), count, true);
  }
  return { rows };
}

export function check({ rows }) {
  const problems = new Map();
  for (const row of rows) {
    const word = row.split && row.length <= 40 && row.words <= 3, short = row.control && row.length <= 24 && row.words <= 3;
    if (!word && !short) continue;
    const measured = word ? `"${row.text}" breaks inside "${row.split}"; keep it on one line` : `"${row.text}" on ${row.lines} lines; keep the label on one line`;
    problems.set(`${row.where}\n${measured}\n${row.box.join(",")}`, { rule: "label wraps", where: row.where, measured, box: row.box, value: row.lines });
  }
  return { problems: [...problems.values()], notChecked: [] };
}
