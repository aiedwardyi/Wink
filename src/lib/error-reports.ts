import { ERROR_SITES } from "../../shared/error-report.mjs";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Anything can be thrown or rejected.
function detail(value: unknown) {
  try {
    if (value instanceof Error) return { name: String(value.name), message: String(value.message), stack: String(value.stack ?? "") };
    return { name: "", message: String(value), stack: "" };
  } catch {
    return { name: "", message: "", stack: "" };
  }
}

export function installRendererErrorReports(target: Window = window) {
  target.addEventListener("error", (event) => { if (event.error) target.ogb?.captureErrorReport?.(ERROR_SITES.rendererError, detail(event.error)); });
  target.addEventListener("unhandledrejection", (event) => target.ogb?.captureErrorReport?.(ERROR_SITES.rendererRejection, detail(event.reason)));
}
