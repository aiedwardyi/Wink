import { toUtterances } from "../../server/tts/speech-text.ts";

let reading = 0;

/** Reads text with the lens's own voice, one short utterance at a time. Meta documents speechSynthesis as the lens's speech path;
 * the phone's ElevenLabs clip starts after two fetches, outside the key press, and the lens never played it. False when the browser has no speechSynthesis. */
export function readAloud(text: string, done: () => void): boolean {
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return false;
  const synth = window.speechSynthesis;
  const parts = toUtterances(text);
  const mine = ++reading;
  synth.cancel();
  if (!parts.length) return false;
  // a cancelled utterance ends too, so only this reading's last one settles it
  const end = () => {
    if (mine === reading) done();
  };
  parts.forEach((part, i) => {
    const utterance = new SpeechSynthesisUtterance(part);
    if (i === parts.length - 1) utterance.onend = end;
    utterance.onerror = () => {
      if (mine !== reading) return;
      stopReading();
      done();
    };
    synth.speak(utterance);
  });
  return true;
}

export function stopReading() {
  reading += 1;
  window.speechSynthesis?.cancel();
}
