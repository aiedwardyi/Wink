export function pageTools() {
  const all = selector => {
    const nodes = document.querySelectorAll(selector);
    if (nodes.length > 5000) throw new Error("resource-limit");
    return [...nodes];
  };
  const visible = node => {
    if (!node?.getClientRects().length) return false;
    for (let p = node; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (p.hidden || s.display === "none" || s.visibility === "hidden" || s.contentVisibility === "hidden" || Number(s.opacity) === 0) return false;
      if (p.parentElement?.matches("details:not([open])") && !p.matches("summary")) return false;
    }
    return true;
  };
  const where = node => {
    if (node.id) return `${node.localName}#${CSS.escape(node.id)}`;
    const parts = [];
    for (let p = node; p && p !== document.body; p = p.parentElement) {
      parts.unshift(`${p.localName}:nth-child(${[...p.parentElement.children].indexOf(p) + 1})`);
      if (p.parentElement?.id) { parts.unshift(`#${CSS.escape(p.parentElement.id)}`); break; }
    }
    return parts.join(" > ").slice(0, 120) || "body";
  };
  return { all, visible, where };
}
