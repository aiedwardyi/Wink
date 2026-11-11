import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

const UPLOAD_PATH = /^\/(?:api\/(?:joined\/)?|room\/v1\/)rooms\/[\w-]{1,64}\/files$/;
const NODE_REPLIES: Record<string, string> = {
  ERR_HTTP_REQUEST_TIMEOUT: "408 Request Timeout",
  HPE_HEADER_OVERFLOW: "431 Request Header Fields Too Large",
  HPE_CHUNK_EXTENSIONS_OVERFLOW: "413 Payload Too Large",
};
const uploading = new WeakSet<Duplex>();

/** A room upload streams at the sender's uplink pace, so it may outlast `requestTimeout`. */
export const isRoomUpload = (req: IncomingMessage) => req.method === "POST" && UPLOAD_PATH.test((req.url ?? "").split("?")[0]!);

/** Room uploads on `server` run past `requestTimeout`; every other request keeps it. */
export function keepRoomUploads(server: Server): void {
  server.on("request", (req: IncomingMessage) => {
    if (!isRoomUpload(req)) return;
    uploading.add(req.socket);
    req.once("close", () => uploading.delete(req.socket));
  });
  server.on("clientError", (error: NodeJS.ErrnoException, socket: Duplex) => {
    if (error.code === "ERR_HTTP_REQUEST_TIMEOUT" && uploading.has(socket)) return;
    // A clientError listener replaces Node's own reply and destroy.
    if (socket.writable && (socket as Socket).bytesWritten === 0) {
      socket.write(`HTTP/1.1 ${NODE_REPLIES[error.code ?? ""] ?? "400 Bad Request"}\r\nConnection: close\r\n\r\n`);
    }
    socket.destroy(error);
  });
}
