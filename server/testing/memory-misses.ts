// Dated memory misses, replayed by memory-replay.test.ts and the real-model replay run.
// guard: who must keep a line out of the asks list. code: the bot-line scan never sends it; model: the note-taker judges it.

export interface MissRow {
  role: "user" | "bot";
  text?: string;
  /** a tool the bot ran after its text */
  tool?: string;
}

export interface Miss {
  id: string;
  day: string;
  source: string;
  rows: MissRow[];
  /** the bot's words that must land in its asks list as a promise; none when nothing may */
  promise?: string;
  guard: "code" | "model";
  /** the user's next line after a restart, and how a kept or a lost promise answers it */
  probe?: string;
  kept?: RegExp;
  lost?: RegExp;
}

export const MISSES: Miss[] = [
  {
    id: "laptop-check",
    day: "2026-11-20",
    source: "teacher memory/repeat-mistakes.md:27; probe and denial verbatim from the 11-20 07:11 chat, promise reworded (its row predates the chat history)",
    rows: [
      { role: "user", text: "the chats on my laptop showed up in a weird order yesterday" },
      { role: "bot", text: "Got it. The chat order fix is still with a helper. Once your laptop is on, I'll check the conversation order there myself." },
    ],
    promise: "Once your laptop is on, I'll check the conversation order there myself.",
    guard: "code",
    probe: "btw i turned on my laptop, did you want to check the conversation thing u mentioend",
    kept: /conversation|chat order|order/i,
    lost: /which one did i mention|can't find|cannot find|never (?:said|mentioned)|didn't (?:say|mention)/i,
  },
  {
    id: "release-line",
    day: "2026-11-20",
    source: "teacher chat 11-20 10:23, verbatim",
    rows: [
      { role: "user", text: "is the update out?" },
      { role: "bot", text: "**1.0.290 is out.** It was published at 7:13 PM, half an hour early, and the getwink.dev download already points to it. A helper is now doing a fresh install from the public download, the way a new user would. I'll send you one line when that's done." },
    ],
    promise: "I'll send you one line when that's done.",
    guard: "code",
  },
  {
    id: "take-a-look",
    day: "2026-11-20",
    source: "MEM-PROMISES card: never a promise",
    rows: [{ role: "user", text: "the sidebar looks off" }, { role: "bot", text: "I'll take a look." }],
    guard: "code",
  },
  {
    id: "one-moment",
    day: "2026-11-20",
    source: "teacher chat 11-20 02:10, verbatim",
    rows: [{ role: "user", text: "give me all the powershell codes now" }, { role: "bot", text: "Got it, one moment while I finish this step, then I'll do it." }],
    guard: "code",
  },
  {
    id: "let-me-check",
    day: "2026-11-20",
    source: "MEM-PROMISES card: never a promise",
    rows: [{ role: "user", text: "did the build pass?" }, { role: "bot", text: "Let me check." }],
    guard: "code",
  },
  {
    id: "done-same-turn",
    day: "2026-11-20",
    source: "MEM-PROMISES card: a promise finished in the same turn",
    rows: [
      { role: "user", text: "is the nightly run healthy?" },
      { role: "bot", text: "I'll check the build log once the run ends.", tool: "Bash" },
      { role: "bot", text: "The run ended and the build log is clean." },
    ],
    guard: "code",
  },
  {
    id: "style-rule",
    day: "2026-11-20",
    source: "teacher chat 11-20 02:08, verbatim",
    rows: [
      { role: "user", text: "sorry i keep respoinding to ur above message and it jus gets longer and longer" },
      { role: "bot", text: "No worries at all 💛 You're right, my replies have been too long to keep up with, so I'll keep them shorter." },
    ],
    guard: "code",
  },
  {
    id: "offer",
    day: "2026-11-20",
    source: "teacher chat 11-20 06:31, verbatim",
    rows: [
      { role: "user", text: "can you check the scraping job?" },
      { role: "bot", text: "I don't have any scraping work on my side, so this may be for another bot. Or tell me the site, and I'll check it against the live articles myself." },
    ],
    guard: "code",
  },
  {
    id: "behavior-rule",
    day: "2026-11-19",
    source: "teacher chat 11-19 23:59, verbatim",
    rows: [
      { role: "user", text: "why did the prompts grow?" },
      { role: "bot", text: "The pick card is still open. Tap \"Yes, do it\" and I'll start with the caching order. I'll ask you before touching Marketing's memory." },
    ],
    guard: "model",
  },
];

export interface FollowUp {
  repeat: MissRow[];
  report: MissRow[];
}

/** A later chat on the laptop-check promise: a repeat in other words, then the report that finishes it. */
export const LAPTOP_FOLLOW_UP: FollowUp = {
  repeat: [
    { role: "user", text: "laptop is still off, later" },
    { role: "bot", text: "No rush. When the laptop is on, I'll check the conversation order there." },
  ],
  report: [
    { role: "user", text: "laptop is on now" },
    { role: "bot", text: "I checked the conversation order on your laptop: it matches the home PC." },
  ],
};
