window.measurements = { raf: 0, transition: false, intersection: false, image: false, clicks: 0 };
function tick() {
  window.measurements.raf += 1;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
const transition = document.getElementById("transition");
transition.addEventListener("transitionend", () => { window.measurements.transition = true; });
requestAnimationFrame(() => requestAnimationFrame(() => { transition.classList.add("active"); }));
new IntersectionObserver((entries) => {
  if (entries.some((entry) => entry.isIntersecting)) window.measurements.intersection = true;
}).observe(document.getElementById("target"));
const image = document.getElementById("lazy");
image.addEventListener("load", () => { window.measurements.image = true; });
if (image.complete && image.naturalWidth) window.measurements.image = true;
document.getElementById("target").addEventListener("click", () => { window.measurements.clicks += 1; });
