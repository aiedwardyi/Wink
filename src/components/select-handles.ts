// Drag handles and Copy for the phone's Select text: phones draw neither for a
// selection a script made, so these stand in for them.

const EDGE = 8;
/** Touch box width in styles.css. */
const GRIP = 44;
const COPY_CLASS =
  "rounded-full border border-hairline/50 bg-card px-4 py-2 text-[14px] text-ink shadow-2xl shadow-black/60";

type End = "start" | "end";

export interface SelectHandles {
  owns(target: EventTarget | null): boolean;
  remove(): void;
}

function grip(end: End): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-select-handle", end);
  el.setAttribute("aria-hidden", "true");
  return el;
}

function lines(range: Range): DOMRect[] {
  return Array.from(range.getClientRects()).filter((rect) => rect.width || rect.height);
}

function caretAt(x: number, y: number): [Node, number] | null {
  const range = document.caretRangeFromPoint?.(x, y);
  if (range) return [range.startContainer, range.startOffset];
  const position = document.caretPositionFromPoint?.(x, y);
  return position ? [position.offsetNode, position.offset] : null;
}

async function copied(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // no clipboard off a secure page, or a refused write: the selection is still live
    return document.execCommand("copy");
  }
}

export function showSelectHandles(row: Element, content: Element, copyLabel: string, onCopy: () => void): SelectHandles {
  const layer = document.createElement("div");
  layer.setAttribute("data-select-handles", "");
  const handles = { start: grip("start"), end: grip("end") };
  const copy = document.createElement("button");
  copy.type = "button";
  copy.setAttribute("data-select-copy", "");
  copy.className = COPY_CLASS;
  copy.textContent = copyLabel;
  layer.append(handles.start, handles.end, copy);
  document.body.append(layer);

  const current = () => {
    const sel = window.getSelection();
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    return range && !range.collapsed && content.contains(range.commonAncestorContainer) ? range : null;
  };

  const place = () => {
    const range = current();
    const rects = range ? lines(range) : [];
    const first = rects[0];
    const last = rects.at(-1);
    layer.hidden = !first || !last;
    if (!first || !last) return;
    // the start box stays on screen while its dot keeps the anchor
    const shift = Math.max(0, GRIP - first.left);
    handles.start.style.transform = `translate(${first.left + shift}px, ${first.bottom}px)`;
    handles.start.style.setProperty("--grip-shift", `${shift}px`);
    handles.end.style.transform = `translate(${last.right}px, ${last.bottom}px)`;
    // above the row clears its name and text; then below the text and the hanging handles
    const view = window.visualViewport;
    const floor = (view ? view.offsetTop + view.height : window.innerHeight) - EDGE;
    const ceiling = Math.max(view?.offsetTop ?? 0, row.closest("[data-orbit-transcript]")?.getBoundingClientRect().top ?? 0) + EDGE;
    const height = copy.offsetHeight;
    const above = row.getBoundingClientRect().top - height - EDGE;
    const below = Math.max(content.getBoundingClientRect().bottom, last.bottom + GRIP / 2) + EDGE;
    const top = above >= ceiling
      ? above
      : below + height <= floor
        ? below
        : Math.max(ceiling, Math.min(first.top - height - EDGE, floor - height));
    const left = Math.max(EDGE, Math.min(first.left, window.innerWidth - copy.offsetWidth - EDGE));
    copy.style.transform = `translate(${left}px, ${top}px)`;
  };

  // the finger sits off the end it drags, so hit-testing keeps that gap
  let lift = 0;
  let nudge = 0;
  const grab = (end: End) => (e: TouchEvent) => {
    e.preventDefault();
    const touch = e.touches[0];
    const range = current();
    const rects = range ? lines(range) : [];
    const line = end === "start" ? rects[0] : rects.at(-1);
    lift = touch && line ? touch.clientY - (line.top + line.bottom) / 2 : 0;
    nudge = touch && line ? touch.clientX - (end === "start" ? line.left : line.right) : 0;
  };
  const drag = (end: End) => (e: TouchEvent) => {
    e.preventDefault();
    const touch = e.touches[0];
    const range = current();
    const sel = window.getSelection();
    if (!touch || !range || !sel) return;
    const caret = caretAt(touch.clientX - nudge, touch.clientY - lift);
    if (!caret || !content.contains(caret[0])) return;
    const [at, atOffset] = caret;
    const [node, offset] = end === "end" ? [range.startContainer, range.startOffset] : [range.endContainer, range.endOffset];
    const pin = document.createRange();
    pin.setStart(node, offset);
    pin.collapse(true);
    // the ends never cross or meet, so each handle keeps its side
    if (pin.comparePoint(at, atOffset) !== (end === "end" ? 1 : -1)) return;
    if (end === "end") sel.setBaseAndExtent(node, offset, at, atOffset);
    else sel.setBaseAndExtent(at, atOffset, node, offset);
    place();
  };
  for (const end of ["start", "end"] as const) {
    handles[end].addEventListener("touchstart", grab(end), { passive: false });
    handles[end].addEventListener("touchmove", drag(end), { passive: false });
  }
  // a press here must not collapse the selection it acts on
  layer.addEventListener("mousedown", (e) => e.preventDefault());
  copy.addEventListener("click", () => {
    // nothing copied keeps the selection for the phone's own copy
    void copied(window.getSelection()?.toString() ?? "").then((ok) => { if (ok) onCopy(); });
  });
  document.addEventListener("selectionchange", place);
  document.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);
  window.visualViewport?.addEventListener("resize", place);
  window.visualViewport?.addEventListener("scroll", place);
  place();

  return {
    owns: (target) => target instanceof Node && layer.contains(target),
    remove() {
      layer.remove();
      document.removeEventListener("selectionchange", place);
      document.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    },
  };
}
