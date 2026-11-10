import { ConnectionError } from "./error-text";
import { t } from "./i18n";

export async function fetchResponse(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { headers: { "content-type": "application/json" }, ...init });
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

export async function request(path: string, init?: RequestInit): Promise<any> {
  const res = await fetchResponse(path, init);
  const body = await responseBody(res);
  if (!res.ok) {
    if (body?.code === "INTERNAL_ERROR") throw new Error(t("errors.request"));
    if (body?.code === "NOT_FOUND") throw new Error(t("errors.notFound"));
    const error: Error & { code?: string; bot?: string } = new Error(body?.error ?? `${res.status} ${res.statusText}`);
    if (typeof body?.code === "string") error.code = body.code;
    if (typeof body?.bot === "string") error.bot = body.bot;
    throw error;
  }
  return body;
}
