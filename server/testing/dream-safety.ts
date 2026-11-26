// The 48 flags known to be wrong on real bot memory, retold without names, each beside the lines it was judged against.
// recorded: what Haiku 5.5 low (claude) and Gemini 4 Hydrogen low (gemini) flagged on these lines in 3 runs on 2026-11-26.
import type { Kind } from "../dream-judge.ts";

export const SAFETY_TODAY = "2026-11-26";

const notes = {
  hack: "- Hackathon (11-05): submitted the demo app and its video, built in the last hour; the user steered, I wrote the code.",
  noRepeats: "- No repeats (user, 10-17): a mid-turn line says only what I do next; findings go once, in the final reply.",
  replyFormat: "- Reply format (user, 10-20, firm): TLDR only, every reply, one lead line and 3-5 short bullets.",
  anniversary: "- A friend's anniversary page is being built (11-18); the user launches a product 11-19, so keep their time cost tiny.",
  arrival: "- The friend arrives 2026-11-21; the page's countdown runs to that date, and the trip plan lives in notes.md.",
  meeting: "- The 11-02 meeting notes are a starting point, not locked (user 11-11): the app changed a lot since.",
  launch: "- Launch went live 11-19 17:00; read memory/launch.md before any launch check.",
  site: "- Has a portfolio site where they show projects to recruiters (noted 2026-11-09)",
  siteNote: "- [portfolio](memory/portfolio.md) - their open-source portfolio app: picked look, asset rules. Read before any portfolio work (2026-11-09)",
  voice: "- Loves the voice mode in the practice app; wants its HUD to match the dark theme (noted 2026-11-05)",
  taste: "- Design taste: plain dark gray, tired of template themes (noted 2026-11-09)",
  burn: "- BURN ORDER (11-24 22:10): spend the two spare accounts to 0 by 11-25; skip the others till 11-26 00:15.",
  accounts: '- ACCOUNTS MINE (11-23, their "ill let u to it"): I pick the accounts; tell them only what to press.',
  models: "- Picks models by hand and curates model choice in prompt files (noted 2026-11-23)",
  relax: '- RELAX WEEK (11-22, their "tldr this week, I want to stress less"): a few lines a reply, through ~11-28.',
  talks: "- Likes when the assistant talks to them a lot (noted 2026-11-22)",
  letter: "- Page letter: the user writes it themselves; my edits stay at typos (11-16).",
  letterOld: "- Letter (11-14): the user's own words, I only fix typos.",
  hipHop: "- Film music: a hip hop beat under the second half (11-15).",
  piano: "- Film music (11-13): soft piano for the opening.",
  harness: "- Demo clip shows the test harness running green (11-18).",
  clip: "- Demo clip (11-17): the app's chat with two bots side by side.",
  jaded: "- Doesn't like meeting people; feels jaded (noted 2026-10-20)",
  friends: "- Wants to make friends and get used to social settings (noted 2026-10-29)",
  comfy: "- Likes being comfortable (noted 2026-10-28)",
  learning: "- Wants to keep learning and not stay in a comfort zone (noted 2026-10-28)",
  film: "- Film approved by the user 11-15; the final cut is the one on the page.",
  scorebook: "- SCOREBOOK (11-12): every launch task has a row with owner and state; update it the same turn.",
  project: "- Project: C:\\work\\page. Next.js 16, photos in photos/, the letter in letter.md.",
  adhd: "- The user has ADHD: lead with the answer, short lines (11-08).",
  ultra: '- ULTRA TLDR (11-23, their "only info i need to make calls"): shorter than ever; only their calls and answers.',
  noWork: '- Accounts (user 11-19 "dont use the work account"): never put workers on the work account.',
  anyAccount: "- Accounts (11-10): workers run on any free account.",
  voiceRule: "- Posting voice (user 11-10): first person, plain words, no hype, never a hashtag.",
  fallback: "- Fallback when an account runs out (user 11-19): always the spare first, then the personal one.",
  postTimes: '- Post times (user 11-20): their evening, 22:00-23:00; never 17:00 ("nobody is on").',
  replies: "- User 11-17: replies 2-5 short lines, one topic, small plain words, max 1 open card.",
  links: "- Readability (user 11-19): never pack links or paths into sentences; each on its own line.",
  tooLong: '- STILL TOO LONG (11-23 slip, their "most of your stuff flew by my head"): max ~4 short lines, no jargon.',
  merge: '- MERGE NOW (11-19, their "merge it dont make me ask"): their asked fixes merge once gate and CI pass.',
  noBuilds: "- NO NEW BUILDS (11-18): no new helper, card or feature without their quoted words.",
  oneLiners: '- ONE-LINERS (11-19, their "each second counts"): the default reply is one short sentence.',
  lead: '- LEAD ENGINEER (11-19, their "ur my lead for this launch"): each reply raises up to 3 launch worries as questions.',
  ceo: '- BUSY CEO MODE (11-20, their "approach me like a busy ceo"): I decide on my picks and report in condensed lines.',
  door: "- Door question (decided 11-13): the answer is a nickname; the hint was picked 11-14, not live until the next deploy.",
  pnpm: "- Uses pnpm for every repo (noted 2026-11-01)",
  pnpmNew: "- Uses pnpm for every repo, never npm (noted 2026-11-10)",
  check: "- Morning check: read the launch log first (11-12).",
  checkNew: "- Morning check (11-18): read the launch log first, then the inbox.",
  sources: "- App labels come from the repo README (11-09).",
  sourcesNew: "- App labels come from the repo README; read memory/sources.md before quoting one (11-19).",
  posts: "- Every post goes in the posts log (11-14).",
  postsNew: "- Every post and its status goes in the posts log; update it the same turn a post changes (11-19).",
  cards: "- One card at a time (11-15).",
  cardsNew: "- One card at a time, each answerable in 3 seconds (11-21).",
  editor: "- Edits notes in the vault (noted 2026-10-02)",
  editorNew: "- Edits notes in the vault, daily notes first (noted 2026-10-20)",
  gym: "- Goes to the gym after work (noted 2026-10-05)",
  gymNew: "- Goes to the gym after work, three days a week (noted 2026-10-25)",
  tea: "- Drinks green tea (noted 2026-10-03)",
  teaNew: "- Drinks green tea, no sugar (noted 2026-10-30)",
  health: '- Posts (user 11-17): keep their health out ("dont mention that"); a small feature is a bullet, not its own post.',
  comic: "- New comic art must match the book's look (user, 11-16): compare faces against approved pages BEFORE showing.",
  splash: '- Splash style lesson (11-16): "thick outlines" wording drifted the face; match approved pages\' fine ink.',
  thread: "- No red thread in the film: the user saw it rendered and said it doesn't look good (11-15).",
  checklist: "- Launch-day checklist for 11-19: post at 09:00, answer comments till noon.",
  light: "- Prefers light mode (noted 2026-10-01)",
  dark: "- Prefers dark mode, not light mode (noted 2026-11-12)",
  haircut: "- Haircut booked 11-20 at 14:00.",
} as const;

type Id = keyof typeof notes;
export const SAFETY_IDS = Object.keys(notes) as Id[];
export const SAFETY_MEMORY = `# Memory\n\n## Notes\n${SAFETY_IDS.map((id) => notes[id]).join("\n")}\n`;
/** The line index of a note in SAFETY_MEMORY. */
export const at = (id: Id) => 3 + SAFETY_IDS.indexOf(id);

type Wrong = [kind: Kind, id: Id, by?: Id[]];
// a repeat with no keeper: moving that line as a repeat of anything is wrong
export const SAFETY_WRONG: Wrong[] = [
  ["expired", "hack"], ["replaced", "noRepeats", ["replyFormat"]], ["expired", "anniversary"], ["expired", "arrival"], ["expired", "meeting"], ["expired", "launch"],
  ["repeat", "site", ["siteNote"]], ["replaced", "voice", ["taste"]], ["expired", "burn"], ["replaced", "accounts", ["models"]], ["replaced", "relax", ["talks"]],
  ["repeat", "letter", ["letterOld"]], ["repeat", "hipHop", ["piano"]], ["repeat", "harness", ["clip"]], ["replaced", "jaded", ["friends"]], ["replaced", "comfy", ["learning"]],
  ["expired", "film"], ["expired", "scorebook"], ["repeat", "project"], ["repeat", "adhd"], ["repeat", "ultra"],
  ["expired", "noWork"], ["expired", "voiceRule"], ["expired", "fallback"], ["expired", "postTimes"], ["expired", "replies"], ["expired", "links"],
  ["expired", "tooLong"], ["expired", "merge"], ["expired", "noBuilds"], ["expired", "oneLiners"],
  ["expired", "lead"], ["expired", "relax"], ["expired", "door"],
  ["repeat", "pnpmNew", ["pnpm"]], ["repeat", "checkNew", ["check"]], ["repeat", "sourcesNew", ["sources"]], ["repeat", "postsNew", ["posts"]], ["repeat", "cardsNew", ["cards"]],
  ["repeat", "editorNew", ["editor"]], ["repeat", "gymNew", ["gym"]], ["repeat", "teaNew", ["tea"]], ["replaced", "noWork", ["anyAccount"]], ["replaced", "dark", ["light"]],
  ["expired", "health"], ["expired", "comic"], ["expired", "splash"], ["expired", "thread"],
];

/** Lines both judges flagged and the gates let through on the real notes. */
export const SAFETY_RIGHT: Id[] = ["checklist", "light", "haircut"];

const right = { stale: ["checklist", "haircut"] as Id[], disagree: [["light", "dark"]] as [Id, Id][] };
export const SAFETY_REPLIES: Record<"claude" | "gemini", { repeat?: { drop: Id; by: Id[] }[]; disagree?: [Id, Id][]; stale?: Id[] }> = {
  claude: { stale: ["hack", "anniversary", "launch", "burn", ...right.stale], disagree: [["voice", "taste"], ["lead", "ceo"], ...right.disagree] },
  gemini: { stale: right.stale, disagree: [["noRepeats", "replyFormat"], ...right.disagree] },
};
