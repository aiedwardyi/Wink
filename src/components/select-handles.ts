// Drag handles and Copy for the phone's Select text: phones draw neither for a
// selection a script made, so these stand in for them.

const EDGE = 8;
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

export function showSelectHandles(content: Element, copyLabel: string, onCopy: () => void): SelectHandles {
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
    handles.start.style.transform = `translate(${first.left}px, ${first.bottom}px)`;
    handles.end.style.transform = `translate(${last.right}px, ${last.bottom}px)`;
    const above = first.top - copy.offsetHeight - EDGE;
    // below, the handles hang under the last line
    const top = above >= EDGE ? above : last.bottom + 28;
    const left = Math.max(EDGE, Math.min(first.left, window.innerWidth - copy.offsetWidth - EDGE));
    copy.style.transform = `translate(${left}px, ${top}px)`;
  };

  // the finger sits below the line it drags, so hit-testing keeps that gap
  let lift = 0;
  const grab = (end: End) => (e: TouchEvent) => {
    e.preventDefault();
    const touch = e.touches[0];
    const range = current();
    const rects = range ? lines(range) : [];
    const line = end === "start" ? rects[0] : rects.at(-1);
    lift = touch && line ? touch.clientY - (line.top + line.bottom) / 2 : 0;
  };
  const drag = (end: End) => (e: TouchEvent) => {
    e.preventDefault();
    const touch = e.touches[0];
    const range = current();
    const sel = window.getSelection();
    if (!touch || !range || !sel) return;
    const caret = document.caretRangeFromPoint?.(touch.clientX, touch.clientY - lift);
    if (!caret || !content.contains(caret.startContainer)) return;
    const [node, offset] = end === "end" ? [range.startContainer, range.startOffset] : [range.endContainer, range.endOffset];
    const pin = document.createRange();
    pin.setStart(node, offset);
    pin.collapse(true);
    // the ends never cross or meet, so each handle keeps its side
    if (pin.comparePoint(caret.startContainer, caret.startOffset) !== (end === "end" ? 1 : -1)) return;
    if (end === "end") sel.setBaseAndExtent(node, offset, caret.startContainer, caret.startOffset);
    else sel.setBaseAndExtent(caret.startContainer, caret.startOffset, node, offset);
    place();
  };
  for (const end of ["start", "end"] as const) {
    handles[end].addEventListener("touchstart", grab(end), { passive: false });
    handles[end].addEventListener("touchmove", drag(end), { passive: false });
  }
  // a press here must not collapse the selection it acts on
  layer.addEventListener("mousedown", (e) => e.preventDefault());
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(window.getSelection()?.toString() ?? "");
    onCopy();
  });
  document.addEventListener("selectionchange", place);
  document.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);
  place();

  return {
    owns: (target) => target instanceof Node && layer.contains(target),
    remove() {
      layer.remove();
      document.removeEventListener("selectionchange", place);
      document.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    },
  };
}
