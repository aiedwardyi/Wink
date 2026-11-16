// What a live voice engine gives the call controller; one adapter per vendor.

import type { LiveVoice } from "../../../shared/live-call";

export type LiveSession = { url: string; token: string; model: string; voice?: LiveVoice; handle?: string };
export type LiveToolCall = { id: string; name: string; args: Record<string, unknown> };

export type LiveEvents = {
  ready(): void;
  /** 24 kHz PCM16 mono. */
  audio(pcm: Int16Array): void;
  heard(text: string): void;
  said(text: string): void;
  /** The user's line ended: the model started its answer. */
  answering(): void;
  turnDone(): void;
  interrupted(): void;
  toolCall(calls: LiveToolCall[]): void;
  toolCancel(ids: string[]): void;
  resumable(handle: string): void;
  goAway(): void;
  usage(totalTokens: number): void;
  closed(code: number, reason: string): void;
};

export interface LiveEngine {
  connect(session: LiveSession, events: LiveEvents): void;
  /** 16 kHz PCM16 mono. */
  sendAudio(pcm: ArrayBuffer): void;
  audioPaused(): void;
  sendText(text: string): void;
  /** Adds to the conversation without asking for a reply. */
  sendContext(text: string): void;
  sendToolResult(ids: string[], name: string, result: unknown): void;
  close(): void;
}
