// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { installRendererErrorReports } from "./error-reports";

it("skips renderer notices without an Error object", () => {
  const captureErrorReport = vi.fn();
  const target = new EventTarget() as Window;
  Object.assign(target, { ogb: { captureErrorReport } });
  installRendererErrorReports(target);
  target.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
  expect(captureErrorReport).not.toHaveBeenCalled();
});

it("forwards the site and the thrown value's detail, never the event's own text", () => {
  const captureErrorReport = vi.fn();
  const target = new EventTarget() as Window;
  Object.assign(target, { ogb: { captureErrorReport } });
  installRendererErrorReports(target);
  const error = new Error("비밀 대화");
  target.dispatchEvent(new ErrorEvent("error", { message: "secret-token C:\\사용자\\민수\\비밀.txt", filename: "/home/minsu/secret", error }));
  const rejection = new Event("unhandledrejection");
  Object.assign(rejection, { reason: "lost" });
  target.dispatchEvent(rejection);
  expect(captureErrorReport.mock.calls).toEqual([[1, { name: "Error", message: "비밀 대화", stack: error.stack }], [2, { name: "", message: "lost", stack: "" }]]);
});
