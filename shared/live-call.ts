// Live call: Gemini Live is the bot's ears and mouth; the bot stays the only worker.

export const LIVE_MODEL = "gemini-3.8-live";
/** The call voice until the person picks another. */
export const LIVE_VOICE = "Aoede";
/** Gemini Live prebuilt voices offered in Settings, shown as Jenn and Eddie. */
export const LIVE_VOICES = ["Aoede", "Achird"] as const;
export type LiveVoice = (typeof LIVE_VOICES)[number];
/** Auto answers in English or Korean, whichever the person speaks, else the app language. */
export const LIVE_LANGUAGES = ["auto", "en", "ko"] as const;
export type LiveLanguage = (typeof LIVE_LANGUAGES)[number];
export function liveGeneration(voice: LiveVoice = LIVE_VOICE) {
  return { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } };
}
export const LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

export const CALL_ID = /^c-[0-9a-f]{12}$/;

/** `voice` marks the voice's speech, `order` a confirmed work order, `ask` a quick ask. A call's first row gets `ms` on hang-up, and `summary` when one came back. */
export type CallTag = { id: string; voice?: true; order?: true; ask?: true; ms?: number; summary?: string };
export type CallLine = { who: "user" | "voice"; text: string; at?: number };

// Korean trails off mid-thought (음, 그러니까...), so both ends are LOW and the pause is long.
export const LIVE_VAD = {
  startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
  endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
  prefixPaddingMs: 300,
  silenceDurationMs: 1_200,
} as const;

// Lower is cheaper per turn and a shorter call memory; the chat keeps every line.
export const LIVE_COMPRESSION = { triggerTokens: 16_000, targetTokens: 10_000 } as const;

export const ORDER_EXPIRY_MS = 45_000;

export const LIVE_TOOLS = [
  {
    name: "propose_work",
    description: "Propose work you will do with full access to the user's PC and projects (open, find, run, check, fix, send, look up a file), for the user to confirm. Nothing starts until they say yes; the result says sent, queued, declined or expired.",
    parameters: {
      type: "OBJECT",
      properties: { order: { type: "STRING", description: "The user's request as they would say it to you, in their words and language, never your offer or reply, e.g. \"Fix the login page bug.\"" } },
      required: ["order"],
    },
  },
  {
    name: "ask",
    description: "Ask about anything not in YOUR NOTES, RECENT CHAT or [Wink] lines (status, files, results, times). No yes needed; the result says sent, queued or not sent, and the answer comes back as a [Wink] line. Anything that changes something is propose_work, even phrased as a question (\"Can you restart it?\").",
    parameters: {
      type: "OBJECT",
      properties: { question: { type: "STRING", description: "The question in the person's words and language, e.g. \"When do the eval loops finish?\"" } },
      required: ["question"],
    },
  },
];

/** Said on the call: never a turn's input, reply or unread. Orders and asks are real sends. */
export function isVoiceLine(row: { call?: CallTag }): boolean {
  return Boolean(row.call && !row.call.order && !row.call.ask);
}
