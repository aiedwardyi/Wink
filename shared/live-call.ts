// Live call: Gemini Live is the bot's ears and mouth; the bot stays the only worker.

export const LIVE_MODEL = "gemini-3.8-live";
/** The call voice until the person picks another. */
export const LIVE_VOICE = "Aoede";
/** Every Gemini Live prebuilt voice; Jenn, Eddie and Adele first. Each has a two-word vibe (callVoice.vibe.* in the i18n catalog). */
export const LIVE_VOICES = [
  "Aoede", "Alnilam", "Erinome", "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel",
  "Algieba", "Despina", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
] as const;
export type LiveVoice = (typeof LIVE_VOICES)[number];
// Must match the picker labels (callVoice.* in the i18n catalog); other voices go by their own name.
const VOICE_NAMES: Partial<Record<LiveVoice, readonly string[]>> = { Aoede: ["Jenn"], Alnilam: ["Eddie"], Erinome: ["Adele", "아델"] };
export function liveVoiceNames(voice: LiveVoice): readonly string[] {
  return VOICE_NAMES[voice] ?? [voice];
}

/** A bot's own call picks; anything unset follows the app (voice in Settings, language from the app). */
export const CALL_STYLES = ["calm", "normal", "lively"] as const;
export type CallStyle = (typeof CALL_STYLES)[number];
export const CALL_SPEED = { min: 0.7, max: 1.3, step: 0.1 } as const;
export type CallPrefs = { voice?: LiveVoice; speed?: number; style?: CallStyle; language?: "en" | "ko" };
// Gemini Live speaks near -17 LUFS; this brings it to about -20, calm beside speech in other apps.
export const OUTPUT_GAIN = 0.7;
// Calm plays 4.4 dB under normal; lively 1 dB over, still under -3 dBTP.
export const STYLE_GAIN: Record<CallStyle, number> = { calm: 0.6, normal: 1, lively: 1.12 };
export const STYLE_LINES: Partial<Record<CallStyle, string>> = {
  calm: "VOICE: Speak softly and gently, low-key and unhurried, like a quiet late-night talk. Never loud or excited.",
  lively: "VOICE: Speak with bright, upbeat energy.",
};
// Live has no accent field, so the accent rides the system instruction.
export const LIVE_ACCENTS: Partial<Record<LiveVoice, string>> = { Erinome: "When you speak English, use a natural British accent." };
export function liveGeneration(voice: LiveVoice = LIVE_VOICE) {
  return { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } };
}
export const LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

export const CALL_ID = /^c-[0-9a-f]{12}$/;

/** `voice` marks the voice's speech, `notice` the app's own line in the voice's place (never sent to the bot), `order` a confirmed work order, `ask` a quick ask. A call's first row gets `ms` on hang-up, and `summary` when one came back. */
export type CallTag = { id: string; voice?: true; notice?: true; order?: true; ask?: true; ms?: number; summary?: string };
export type CallLine = { who: "user" | "voice" | "notice"; text: string; at?: number };

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

/** Leads a voice line wherever it is replayed to a model: the voice checked nothing. */
export const VOICE_SAID = "[said on a call, unverified]";
