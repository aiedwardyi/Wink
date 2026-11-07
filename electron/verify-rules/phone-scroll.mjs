export const id = "FIT";
export const label = "phone sideways scroll";

export function observe({ all, visible, where }) {
  const width = document.documentElement.clientWidth;
  const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  const node = scrollWidth > width + 1 && all("body *").find(n => visible(n) && n.getBoundingClientRect().right > width + 1 && !n.parentElement?.closest("[hidden],dialog:not([open])"));
  return { width, scrollWidth, where: node ? where(node) : "page" };
}

export function check({ width, scrollWidth, where = "page" }) {
  return { problems: scrollWidth > width + 1 ? [{ rule: "sideways scroll", where, measured: `${scrollWidth} px page at ${width} px; scroll sideways on the phone` }] : [], notChecked: [] };
}
