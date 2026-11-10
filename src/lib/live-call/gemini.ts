// Gemini Live over a WebSocket opened with the PC's 1-use token; the setup is locked in the token.
import type { LiveEngine, LiveEvents, LiveSession } from "./engine";

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function fromBase64(data: string): Int16Array {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length & ~1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

type ServerMessage = {
  setupComplete?: object;
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    generationComplete?: boolean;
    turnComplete?: boolean;
    interrupted?: boolean;
  };
  toolCall?: { functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> };
  toolCallCancellation?: { ids?: string[] };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  goAway?: object;
  usageMetadata?: { totalTokenCount?: number };
};

/** Routes one server frame to the call; exported for tests. */
export function route(msg: ServerMessage, events: LiveEvents, turn: { answering: boolean }) {
  if (msg.setupComplete) events.ready();
  const content = msg.serverContent;
  if (content) {
    if (content.inputTranscription?.text) events.heard(content.inputTranscription.text);
    const parts = content.modelTurn?.parts ?? [];
    if (!turn.answering && (parts.length || content.outputTranscription?.text || content.generationComplete)) {
      turn.answering = true;
      events.answering();
    }
    for (const part of parts) if (part.inlineData?.data) events.audio(fromBase64(part.inlineData.data));
    if (content.outputTranscription?.text) events.said(content.outputTranscription.text);
    if (content.interrupted) {
      turn.answering = false;
      events.interrupted();
    }
    if (content.turnComplete) {
      turn.answering = false;
      events.turnDone();
    }
  }
  const calls = msg.toolCall?.functionCalls;
  if (calls?.length) events.toolCall(calls.map((call) => ({ id: call.id ?? "", name: call.name ?? "", args: call.args ?? {} })));
  if (msg.toolCallCancellation?.ids?.length) events.toolCancel(msg.toolCallCancellation.ids);
  if (msg.sessionResumptionUpdate?.newHandle && msg.sessionResumptionUpdate.resumable !== false) events.resumable(msg.sessionResumptionUpdate.newHandle);
  if (msg.goAway) events.goAway();
  if (msg.usageMetadata?.totalTokenCount) events.usage(msg.usageMetadata.totalTokenCount);
}

export class GeminiLive implements LiveEngine {
  private ws: WebSocket | null = null;

  connect(session: LiveSession, events: LiveEvents) {
    const ws = new WebSocket(`${session.url}?access_token=${encodeURIComponent(session.token)}`);
    const turn = { answering: false };
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ setup: { model: `models/${session.model}`, ...(session.handle ? { sessionResumption: { handle: session.handle } } : {}) } }));
    ws.onmessage = async (event) => {
      const text = typeof event.data === "string" ? event.data : await (event.data as Blob).text();
      if (this.ws !== ws) return;
      try {
        route(JSON.parse(text) as ServerMessage, events, turn);
      } catch {
        // a frame we cannot read is dropped, not fatal
      }
    };
    ws.onclose = (event) => {
      if (this.ws === ws) this.ws = null;
      events.closed(event.code, event.reason);
    };
  }

  private send(frame: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  sendAudio(pcm: ArrayBuffer) {
    this.send({ realtimeInput: { audio: { data: toBase64(new Uint8Array(pcm)), mimeType: "audio/pcm;rate=16000" } } });
  }

  audioPaused() {
    this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  sendText(text: string) {
    this.send({ realtimeInput: { text } });
  }

  sendToolResult(id: string, name: string, result: unknown) {
    this.send({ toolResponse: { functionResponses: [{ id, name, response: { result } }] } });
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000);
  }
}
