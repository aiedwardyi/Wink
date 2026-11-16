import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";

import { keepErrorReports, turnOffErrorReports } from "./error-reports.ts";

let close = () => {};
afterEach(() => close());

async function desktop(statuses: number[]) {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(statuses.shift() ?? 500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => {
    server.closeAllConnections();
    server.close();
  };
  // SAFETY: a listening TCP server's address is an AddressInfo.
  return { bodies, access: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "token" } };
}

it("asks the desktop app again until it says crash reports are off", async () => {
  const { bodies, access } = await desktop([500, 503, 204]);
  await turnOffErrorReports(access, [1, 1, 1, 1]);
  expect(bodies).toEqual(Array(3).fill('{"consent":false}'));
});

it("stops asking once the switch is back on", async () => {
  const { bodies, access } = await desktop([]);
  const asking = turnOffErrorReports(access, [50, 50]);
  await vi.waitFor(() => expect(bodies).toHaveLength(1));
  keepErrorReports();
  await asking;
  expect(bodies).toHaveLength(1);
});

it("gives up after its last wait", async () => {
  const { bodies, access } = await desktop([]);
  await turnOffErrorReports(access, [1, 1]);
  expect(bodies).toHaveLength(3);
});
