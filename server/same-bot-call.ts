// A same-bot call: the bot answers in its own chat, and Gemini Live is only the ears (his words as text) and the mouth (the reply read out).
import { LIVE_ACCENTS, LIVE_COMPRESSION, LIVE_MODEL, LIVE_VAD, LIVE_VOICE, liveGeneration, type LiveVoice } from "../shared/live-call.ts";

/** No brief and no tools: nothing about the bot or its work goes to the voice but the replies it reads. */
export function sameBotSetup(botName: string, locale = "en", voice: LiveVoice = LIVE_VOICE) {
  const app = locale === "ko" ? "ko" : "en";
  const name = botName.trim() || "the bot";
  const rules = [
    `You are only the voice of ${name} on a phone call. You never answer, explain or add anything yourself: ${name} answers in its chat, and you read its words.`,
    "Every message you get starts with [READ]. Say the text after [READ] aloud exactly as written, word for word, in its own language, then stop. Never add a greeting, a comment or a question, and never shorten, reword or translate it.",
    `When the person speaks, say nothing at all: their words go to ${name} as text, and its answer comes back to you as [READ].`,
  ];
  return {
    model: `models/${LIVE_MODEL}`,
    generationConfig: liveGeneration(voice),
    systemInstruction: { parts: [{ text: [...rules, LIVE_ACCENTS[voice]].filter(Boolean).join("\n\n") }] },
    inputAudioTranscription: { languageCodes: [app, app === "ko" ? "en" : "ko"] },
    outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: LIVE_VAD },
    contextWindowCompression: { triggerTokens: LIVE_COMPRESSION.triggerTokens, slidingWindow: { targetTokens: LIVE_COMPRESSION.targetTokens } },
    sessionResumption: {},
  };
}
