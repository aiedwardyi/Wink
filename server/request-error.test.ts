import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

it("logs the exception but never returns its text", async () => {
  const { requestError } = await import("./request-error.ts");
  const log = vi.fn();
  const error = Object.assign(new Error("ENOENT C:\\private\\keys.db"), { status: 503 });
  const result = requestError(error, log);
  expect(log).toHaveBeenCalledWith(error.message);
  expect(result).toEqual({ status: 503, body: { code: "INTERNAL_ERROR", error: "Wink couldn't finish that. Try again." } });
  expect(JSON.stringify(result)).not.toContain("private");
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(source).toContain("const failure = requestError(e);");
  expect(source).not.toContain('return json(res, status, { error: e instanceof Error ? e.message : String(e) });');
});

it("returns 404 without echoing an unknown route", async () => {
  const { unknownRoute, requestError } = await import("./request-error.ts");
  expect(unknownRoute.code).toBe("NOT_FOUND");
  expect(requestError(null, () => {}).status).toBe(500);
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(source).toContain("return json(res, 404, unknownRoute);");
  expect(source).not.toContain('no route: ${method} ${path}');
});

it.each([400, 409, 413])("preserves explicit %s route errors", async (status) => {
  const { requestError } = await import("./request-error.ts");
  const log = vi.fn();
  const error = Object.assign(new Error("raw route validation"), { status });
  expect(requestError(error, log)).toEqual({ status, body: { error: error.message } });
  expect(log).toHaveBeenCalledWith(error.message);
});

it("sends the code of a refused sign-in", async () => {
  const { requestError } = await import("./request-error.ts");
  const { LoginBusyError } = await import("./engine-login.ts");
  expect(requestError(new LoginBusyError(), () => {})).toEqual({
    status: 409,
    body: { error: "Another sign-in for this engine is still running", code: "login-busy" },
  });
});
