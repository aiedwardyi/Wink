import { expect, it } from "vitest";
import { translate } from "./i18n";
import { lateReportText } from "./late-report";

it("localizes only the queued report suffix, preserving the worker's words", () => {
  const text = "The build passed.\n(sent 14:02 while Wink was closed)";
  expect(lateReportText(text, (key, vars) => translate("en", key, vars))).toBe(text);
  expect(lateReportText(text, (key, vars) => translate("ko", key, vars))).toBe("The build passed.\n(Wink가 닫혀 있을 때 14:02에 보냄)");
  const plain = "The worker said sent 14:02 while Wink was closed.";
  expect(lateReportText(plain, (key, vars) => translate("ko", key, vars))).toBe(plain);
});
