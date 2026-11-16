// A system face's first layout stalls the press that meets it, so the ones a first session hits are laid out once, hidden, at idle.
const FACES: [className: string, text: string][] = [
  ["font-mono text-[11px]", "ABCD"],
  ["text-[16px]", "↵"],
  ["text-[12.5px] font-medium", "한국어"],
];

/** One per idle slot; each lays out its face's text offscreen and removes it in the same task. */
export const faceWarms = FACES.map(([className, text]) => async () => {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  span.setAttribute("aria-hidden", "true");
  span.style.cssText = "position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;white-space:nowrap";
  document.body.append(span);
  void span.offsetWidth;
  span.remove();
});
