import { ConnectionError } from "./error-text";
import { t } from "./i18n";
import { leaveSignedOut, SIGNED_OUT } from "./signed-out";

const CLIENT_KEY = "wink.client";
const CLIENT_NAME = /^wink\.client:([0-9a-f]{32})$/;
let client: string | undefined;

/** This tab's own id: the server lets only the tab that started a sign-in answer or cancel it.
 * The window name and session storage both belong to one tab and survive its reloads; the name needs no storage. */
export function clientId(): string {
  if (client) return client;
  try { client = CLIENT_NAME.exec(window.name)?.[1] ?? /^[0-9a-f]{32}$/.exec(sessionStorage.getItem(CLIENT_KEY) ?? "")?.[0]; } catch { /* storage blocked */ }
  client ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  try {
    if (!window.name || CLIENT_NAME.test(window.name)) window.name = `wink.client:${client}`;
    sessionStorage.setItem(CLIENT_KEY, client);
  } catch { /* storage blocked: the window name still holds it */ }
  return client;
}

export async function fetchResponse(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { headers: { "content-type": "application/json", "x-wink-client": clientId() }, ...init });
  } catch (cause) {
    if (cause instanceof TypeError) throw new ConnectionError();
    throw cause;
  }
}

export async function responseBody(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    if (res.status >= 500) throw new ConnectionError();
    return {};
  }
}

/** onResponse runs once the headers are in, while the body may still be arriving. */
export async function request(path: string, init?: RequestInit, onResponse?: () => void): Promise<any> {
  const res = await fetchResponse(path, init);
  onResponse?.();
  const body = await responseBody(res);
  if (!res.ok) {
    if (res.status === 401 && body?.code === SIGNED_OUT) void leaveSignedOut();
    if (body?.code === "INTERNAL_ERROR") throw new Error(t("errors.request"));
    if (body?.code === "NOT_FOUND") throw new Error(t("errors.notFound"));
    const error: Error & { code?: string; bot?: string; file?: string; status?: number } = new Error(body?.error ?? `${res.status} ${res.statusText}`);
    if (typeof body?.code === "string") error.code = body.code;
    if (typeof body?.bot === "string") error.bot = body.bot;
    if (typeof body?.file === "string") error.file = body.file;
    error.status = res.status;
    throw error;
  }
  return body;
}
