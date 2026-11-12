import { afterEach, describe, expect, it, vi } from "vitest";

import { LIVE_VOICE } from "../../../shared/live-call";
import type { LiveEvents } from "./engine";
import { GeminiLive } from "./gemini";

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket;
  readyState = 1;
  frames: any[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
  constructor(readonly url: string) { FakeSocket.last = this; }
  send(text: string) { this.frames.push(JSON.parse(text)); }
  close() {}
}

function open(handle?: string) {
  vi.stubGlobal("WebSocket", FakeSocket);
  const live = new GeminiLive();
  live.connect({ url: "wss://x", token: "t", model: "m", ...(handle ? { handle } : {}) }, {} as LiveEvents);
  FakeSocket.last.onopen!();
  return { live, socket: FakeSocket.last };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("GeminiLive", () => {
  it.each([undefined, "h1"])("names the call voice on every setup, resumed too: %s", (handle) => {
    const { socket } = open(handle);
    expect(socket.frames[0].setup.generationConfig).toEqual({ responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE } } } });
  });

  it("names the voice the token picked", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    new GeminiLive().connect({ url: "wss://x", token: "t", model: "m", voice: "Charon" }, {} as LiveEvents);
    FakeSocket.last.onopen!();
    expect(FakeSocket.last.frames[0].setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Charon");
  });

  it("never sends context alone, it rides the next text", () => {
    const { live, socket } = open();
    live.sendContext("[Wink] Status now.");
    expect(socket.frames).toHaveLength(1);
    live.sendText("[Wink] Nova replied: Done.");
    expect(socket.frames.slice(1)).toEqual([{ realtimeInput: { text: "[Wink] Status now.\n\n[Wink] Nova replied: Done." } }]);
    live.sendText("Next.");
    expect(socket.frames.at(-1)).toEqual({ realtimeInput: { text: "Next." } });
    expect(socket.frames.some((frame) => frame.clientContent)).toBe(false);
  });
});
