/** Marks a scroller whose content runs past its bottom edge, for a fade that says there is more. */
export function markCut(body: HTMLElement) {
  body.toggleAttribute("data-cut", body.scrollHeight - body.scrollTop - body.clientHeight > 1);
}
