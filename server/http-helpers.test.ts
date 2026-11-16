import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import { readBody } from "./http-helpers.ts";

function sent(chunks: string[]) {
  const stream = new PassThrough();
  // SAFETY: readBody only listens for data, end and error.
  const body = readBody(stream as unknown as IncomingMessage, 64);
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  return body;
}

it("counts the bytes it reads, so a body with no declared length still meets the limit", async () => {
  expect(await sent(['{"events":[', '"a"', "]}"])).toEqual({ events: ["a"] });
  await expect(sent(['{"events":["', "x".repeat(40), "x".repeat(40), '"]}'])).rejects.toMatchObject({ status: 413, message: "body too large" });
});
