import type { IncomingMessage, Server, ServerResponse } from "node:http";

export function waitForFirstPage(server: Server, timeoutMs = 1_500): Promise<void> {
  return new Promise((resolve) => {
    let response: ServerResponse | undefined;
    const finish = () => {
      clearTimeout(timer);
      server.off("request", request);
      response?.off("finish", finish);
      resolve();
    };
    const request = (req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? "").split("?")[0];
      if (req.method !== "GET" || (path !== "/" && path !== "/index.html")) return;
      response = res;
      server.off("request", request);
      res.once("finish", finish);
      if (res.writableFinished) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    server.on("request", request);
  });
}
