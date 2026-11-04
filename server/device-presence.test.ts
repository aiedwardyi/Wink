import { afterEach, expect, it, vi } from "vitest";
import type { DeviceListItem } from "./device-sync.ts";
import { createDevicePresence } from "./device-presence.ts";

const pc = (deviceId: string, extra: Partial<DeviceListItem> = {}): DeviceListItem => ({
  deviceId, name: deviceId, host: `${deviceId}.tail1234.ts.net`, lastSeen: 0, current: false, offline: false, ...extra,
});
const local = "home.tail1234.ts.net";
afterEach(() => vi.useRealTimers());

it("reports unknown at launch, then each PC as soon as its health settles", async () => {
  const resolvers = new Map<string, (value: Response) => void>();
  const request = vi.fn((url: string) => new Promise<Response>((done) => resolvers.set(new URL(url).hostname, done)));
  const presence = createDevicePresence(request as typeof fetch);
  const items = [pc("home", { current: true }), pc("work", { offline: true, checking: true }), pc("laptop")];
  expect(presence(items, local).map(({ checking }) => checking)).toEqual([false, true, true]);
  resolvers.get("work.tail1234.ts.net")!(Response.json({ app: "openmausbot" }));
  await vi.waitFor(() => expect(presence(items, local)[1]).toMatchObject({ offline: false, checking: false }));
  expect(presence(items, local)[2].checking).toBe(true);
  resolvers.get("laptop.tail1234.ts.net")!(Response.json({}, { status: 503 }));
  await vi.waitFor(() => expect(presence(items, local)[2]).toMatchObject({ offline: true, checking: false }));
  expect(request).toHaveBeenCalledTimes(2);
});

it("rechecks an offline PC, preserves live presence through Drive catch-up and uses its new name", async () => {
  let clock = 0;
  const request = vi.fn().mockRejectedValue(new Error("offline"));
  const presence = createDevicePresence(request, () => clock);
  let items = [pc("home", { current: true }), pc("work", { checking: true })];
  presence(items, local);
  await vi.waitFor(() => expect(presence(items, local)[1].offline).toBe(true));
  clock = 2_000;
  request.mockResolvedValue(Response.json({ app: "openmausbot" }));
  items = [items[0], { ...items[1], name: "Studio", offline: true }];
  presence(items, local);
  await vi.waitFor(() => expect(presence(items, local)[1]).toMatchObject({ name: "Studio", checking: false, offline: false }));
});

it("does not probe relay hosts, unknown tailnets or another tailnet", () => {
  const request = vi.fn();
  const presence = createDevicePresence(request);
  const items = [pc("relay", { host: "aaaaaaaaaaaaaaaa.wink.test" }), pc("other", { host: "work.other.ts.net" })];
  expect(presence(items, local)).toEqual(items);
  expect(presence([pc("work")], undefined)).toEqual([pc("work")]);
  expect(request).not.toHaveBeenCalled();
});

it.each([Response.json({ app: "other" }), Response.json(null), new Response("not json")])("rejects a non-Wink health answer", async (response) => {
  const presence = createDevicePresence(vi.fn().mockResolvedValue(response));
  const items = [pc("work")];
  presence(items, local);
  await vi.waitFor(() => expect(presence(items, local)[0].offline).toBe(true));
});

it("settles a timed out launch probe in 1500 ms without waiting for Drive", async () => {
  vi.useFakeTimers();
  const request = vi.fn((_url, init) => new Promise<Response>((_done, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("offline")));
  }));
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  try {
    const presence = createDevicePresence(request);
    const items = [pc("work")];
    expect(presence(items, local)[0].checking).toBe(true);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(presence(items, local)[0].checking).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(presence(items, local)[0]).toMatchObject({ checking: false, offline: true });
  } finally {
    timeout.mockRestore();
  }
});
