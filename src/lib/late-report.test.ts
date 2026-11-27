import { expect, it } from "vitest";
import { translate } from "./i18n";
import { parsePaneNote } from "../../shared/pane-note";
import { lateReportText } from "./late-report";
import { noteText } from "./pane-note";

it("localizes only the queued report suffix, preserving the worker's words", () => {
  const text = "The build passed.\n(sent 14:02 while Wink was closed)";
  expect(lateReportText(text, (key, vars) => translate("en", key, vars))).toBe(text);
  expect(lateReportText(text, (key, vars) => translate("ko", key, vars))).toBe("The build passed.\n(Wink가 닫혀 있을 때 14:02에 보냄)");
  const queued = parsePaneNote("[pane 0f3c9a1e] from worker (w1): DONE N branch=x sha=y dirty=no\nThe build passed.\n(sent 14:02 while Wink was closed)\n[truncated]\nFull report: C:\\orbit\\report.txt");
  const ko = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) => translate("ko", key, vars);
  expect(lateReportText(noteText(queued, ko), ko)).toBe("The build passed.\n(Wink가 닫혀 있을 때 14:02에 보냄)…\nFull report: C:\\orbit\\report.txt");
  const plain = "The worker said sent 14:02 while Wink was closed.";
  expect(lateReportText(plain, (key, vars) => translate("ko", key, vars))).toBe(plain);
});
