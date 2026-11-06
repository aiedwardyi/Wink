import { expect, it } from "vitest";
import { verifyReplyText } from "./verify-message.ts";
import type { VerifyResult } from "../shared/live-verify.ts";

it("caps bot feedback and excludes design details from defects", () => {
  const issues = Array.from({ length: 40 }, (_, i) => ({ checker: "LINKS" as const, tile: "phone" as const, rule: "missing target", where: `a#link-${i}`, measured: "#missing has no target" }));
  const result: VerifyResult = { v: 1, runId: "run-123456", site: "index.html", counts: { planned: 40, completed: 40, passed: 0, failed: 40, blocked: 0, notRun: 0 }, issues, issueTotal: 40, durationMs: 12000, notChecked: ["form delivery"], details: [{ ...issues[0]!, checker: "CONTRAST", rule: "contrast", measured: "3.1:1" }] };
  const text = verifyReplyText("completed", result.site, { result });
  expect(text.length).toBeLessThanOrEqual(1200);
  expect(text).toContain("Not checked: form delivery");
  expect(text).toContain("phone");
  expect(text).toContain("392");
  expect(text).not.toMatch(/contrast|checks|3.1:1/);
});
