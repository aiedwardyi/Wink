import { expect, it } from "vitest";
import { ERROR_CODES, ERROR_SITES, makeErrorReport, validErrorReport } from "./error-report.mjs";

const context = { build: "1.0.212", platform: "win32", arch: "x64", uptime: 100, now: Date.UTC(2026, 9, 28), reportId: "a".repeat(32) };

it("reconstructs a payload without accepting producer metadata", () => {
  const report = makeErrorReport({ process: "server", code: "secret error", site: ERROR_SITES.serverRuntime }, context)!;
  expect(Object.keys(report)).toEqual(["schema", "build", "platform", "arch", "process", "code", "site", "errorName", "frame", "exitCode", "count", "uptimeBucket", "utcHour", "reportId"]);
  expect(report.code).toBe("UNKNOWN_ERROR");
  expect(validErrorReport({ ...report, message: "비밀" })).toBe(false);
  for (const code of ERROR_CODES) expect(validErrorReport({ ...report, code })).toBe(true);
});

it("keeps only an error class name and an app bundle frame from the input", () => {
  const input = { process: "renderer", code: "UNKNOWN_ERROR", site: ERROR_SITES.rendererError, errorName: "TypeError", frame: "index-AbC_12.js:1:2345", message: "비밀 대화" };
  const report = makeErrorReport(input, context)!;
  expect(report).toMatchObject({ schema: 2, errorName: "TypeError", frame: "index-AbC_12.js:1:2345" });
  expect("message" in report).toBe(false);
  for (const errorName of ["비밀 대화", "secret token", "C:\\Users\\minsu", "Error: 민수", "secret-token-123"]) expect(makeErrorReport({ ...input, errorName }, context)!.errorName).toBe("");
  for (const frame of ["C:\\사용자\\민수\\비밀.txt:1:2", "/home/minsu/a.js:1:2", "https://evil.test/a.js:1:2", "index.js", "../x.js:1:2", "비밀 대화.js:1:2", "a.js:1:2 secret"]) expect(makeErrorReport({ ...input, frame }, context)!.frame).toBe("");
  for (const patch of [{ errorName: "비밀" }, { frame: "/home/minsu/a.js:1:2" }, { schema: 1 }, { frame: 4 }]) expect(validErrorReport({ ...report, ...patch })).toBe(false);
});

it.each([
  { build: "C:\\사용자\\민수\\비밀.txt" }, { platform: "secret" }, { arch: "secret" }, { reportId: "secret" },
])("rejects untrusted context %j", (patch) => {
  expect(makeErrorReport({ process: "main", code: "UNKNOWN_ERROR", site: 1 }, { ...context, ...patch })).toBeNull();
});

it("rejects invalid sites, processes and numeric bounds", () => {
  expect(makeErrorReport({ process: "main", code: "UNKNOWN_ERROR", site: 999 }, context)).toBeNull();
  expect(makeErrorReport({ process: "/home/minsu", code: "UNKNOWN_ERROR", site: 1 }, context)).toBeNull();
  const report = makeErrorReport({ process: "main", code: "UNKNOWN_ERROR", site: 1 }, context)!;
  for (const patch of [{ count: 0 }, { count: 10001 }, { exitCode: 2 ** 32 }, { uptimeBucket: 4 }, { utcHour: 1.5 }, { code: "secret" }]) expect(validErrorReport({ ...report, ...patch })).toBe(false);
});
