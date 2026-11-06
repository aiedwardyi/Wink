export const id = "FIT";
export const label = "layout details";

export function observe({ all, visible, where }) {
  const rows = [], nodes = all("a,button,input,select,textarea,h1,h2,h3,h4,p,li,label,span").filter(visible);
  const geometry = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
  const add = (node, rule, bad, measured, box = geometry(node)) => rows.push({ where: where(node), rule, bad, measured, box, scrollY });
  const textNodes = [];
  for (const node of nodes) {
    const box = geometry(node), text = node.textContent.trim(), style = getComputedStyle(node);
    if (node.matches("a,button,input,select,textarea,[role=button]")) add(node, "tap size", box[2] < 44 || box[3] < 44, `${Math.round(box[2])} x ${Math.round(box[3])} px; 44 px target`);
    const direct = [...node.childNodes].filter(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!direct.length || !text || node.closest("script,style,pre,code,[contenteditable=true]")) continue;
    textNodes.push(node);
    const range = document.createRange(); range.selectNodeContents(node);
    const rects = [...range.getClientRects()];
    const width = Math.max(0, ...rects.map(r => r.right - Math.max(r.left, box[0])));
    const bad = Math.max(width, node.scrollWidth) > node.clientWidth + 1 && node.clientWidth > 0;
    const ellipsis = style.textOverflow === "ellipsis", visibleChars = text.length * node.clientWidth / Math.max(1, node.scrollWidth);
    add(node, "text cut off", bad && (!ellipsis || visibleChars < 8), `${Math.round(Math.max(width, node.scrollWidth))} px text / ${node.clientWidth} px available`);
    for (const child of direct) for (const match of child.textContent.matchAll(/[가-힣]{2,}/g)) {
      range.setStart(child, match.index); range.setEnd(child, match.index + match[0].length);
      const lines = new Set([...range.getClientRects()].map(r => Math.round(r.top)));
      add(node, "Korean split mid-word", lines.size > 1, `${match[0].slice(0, 40)} on ${lines.size} lines`);
    }
  }
  for (let i = 0; i < textNodes.length; i++) {
    const a = textNodes[i], ar = geometry(a);
    let overlap = 0, gap = 0, compared = false;
    for (let j = i + 1; j < textNodes.length; j++) {
      const b = textNodes[j];
      if (a.contains(b) || b.contains(a)) continue;
      const br = geometry(b), width = Math.min(ar[0] + ar[2], br[0] + br[2]) - Math.max(ar[0], br[0]), height = Math.min(ar[1] + ar[3], br[1] + br[3]) - Math.max(ar[1], br[1]);
      if (a.parentElement !== b.parentElement) continue;
      compared = true;
      if (width >= 2 && height >= 2) overlap = Math.max(overlap, Math.min(width, height));
      const drift = Math.abs(ar[0] - br[0]);
      if (height <= 0 && drift >= 2 && drift <= 20) gap = Math.max(gap, drift);
    }
    if (compared) {
      add(a, "overlap", overlap > 0, `${Math.round(overlap)} px intersection with a sibling`);
      add(a, "edges out of line", gap > 0, `${Math.round(gap)} px left-edge difference in the column`);
    }
  }
  return { rows };
}

export function check({ rows }) {
  return { problems: [], notChecked: [], details: rows.filter(row => row.bad).map(({ bad: _bad, ...row }) => row) };
}
