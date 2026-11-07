import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { frameBitmap, readReplay, type VerifyReplayChunk } from "./verify-replay";

const file = new Uint8Array(readFileSync(new URL("../../scripts/fixtures/verify-replay/sample.lvr", import.meta.url)));
afterEach(() => { vi.unstubAllGlobals(); });

async function all(source: Parameters<typeof readReplay>[0]) {
  const out: VerifyReplayChunk[] = [];
  for await (const chunk of readReplay(source)) out.push(chunk);
  return out;
}
function stream(bytes: Uint8Array, sizes: number[]) {
  let at = 0, i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      const n = sizes[i++ % sizes.length]!;
      controller.enqueue(bytes.slice(at, at + n));
      at += n;
    },
  });
}

it("reads the sample file: header first, both tiles, marks, then the end with a boxed problem", async () => {
  expect(file.length).toBeLessThan(300 * 1024);
  const chunks = await all(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  expect(chunks[0]).toMatchObject({ kind: "head", head: { v: 1, tiles: { desktop: [1280, 720], phone: [392, 800] } } });
  const head = chunks[0]!.kind === "head" ? chunks[0].head : null;
  expect(head?.page).not.toMatch(/^[a-zA-Z]:|^[\\/]/);
  const frames = chunks.filter(c => c.kind === "frame");
  expect(new Set(frames.map(f => f.kind === "frame" && f.tile))).toEqual(new Set(["desktop", "phone"]));
  for (const f of frames) if (f.kind === "frame") expect([...f.jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  expect(chunks.some(c => c.kind === "mark" && c.mark.kind === "part")).toBe(true);
  const end = chunks.at(-1)!;
  expect(end.kind).toBe("end");
  if (end.kind === "end") expect(end.end.issues.some(issue => issue.box?.length === 4)).toBe(true);
});

it("reads the same chunks from a fetch body split at any byte, with or without the magic", async () => {
  const whole = await all(file);
  for (const sizes of [[1], [3, 7, 4096], [65536]]) {
    const parts = await all(stream(file, sizes));
    expect(parts.map(c => c.kind)).toEqual(whole.map(c => c.kind));
  }
  const live = await all(stream(file.subarray(4), [513]));
  expect(live.map(c => c.kind)).toEqual(whole.map(c => c.kind));
});

it("skips chunks it cannot read and stops on a broken length", async () => {
  const bad = (kind: number, payload: number[]) => [payload.length + 1, 0, 0, 0, kind, ...payload];
  const bytes = new Uint8Array([...bad(2, [...Buffer.from("not json")]), ...bad(9, [1, 2]), ...bad(2, [...Buffer.from('{"ms":5,"kind":"part","part":"loads"}')])]);
  expect((await all(bytes)).map(c => c.kind === "mark" && c.mark.kind)).toEqual(["part"]);
  await expect(all(new Uint8Array([0, 0, 0, 0, 1]))).rejects.toThrow("bad replay chunk");
});

it("decodes frames with createImageBitmap from a JPEG blob", async () => {
  const create = vi.fn(async (blob: Blob) => ({ type: blob.type, size: blob.size }));
  vi.stubGlobal("createImageBitmap", create);
  const frame = (await all(file)).find(c => c.kind === "frame")!;
  if (frame.kind !== "frame") throw new Error("no frame");
  await expect(frameBitmap(frame.jpeg)).resolves.toEqual({ type: "image/jpeg", size: frame.jpeg.length });
});
