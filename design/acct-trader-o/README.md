# ACCT-TRADER-O: Race to reset (design prototype)

Design-only prototype for how Wink shows usage limits and many accounts. It changes no product code: the harness swaps four components into the real app at render time, by path.

- `fixtures.ts`: the card's fixture accounts. "Now" is Wed Nov 4 2026, 3:12 PM in Seoul. There is a busy morning, then a quiet afternoon. Claude 2 ran out at 10:52 AM and Wink moved new work to Claude 1.
- `pace.ts`: pure pace math. It covers samples, the even-pace guide, the recent rate, the verdict ("Lasts to reset", "Runs out ~time", "Back time"), the deciding window, volume buckets, and today vs normal.
- `strings.ts`: en and ko copy, plus clock and countdown helpers. The build moves the copy into `src/lib/i18n-catalog.ts`.
- `desk-store.ts`: a small live store with its own clock and the actions use, pin, report and nextMorning. `window.__desk` drives the clip.
- `Chart.tsx`: the race chart (SVG). Terminal skins get a braille version. Also the small `Spark` line.
- `Desk.tsx`: the Usage page: ticker strip, hero, chart, account rows (tap a row to use it) and the "Stay on" pin.
- `QuickView.tsx`: the chat ticker line and its quick view, a card that grows up out of the line on desktop and phone (Terminal skins seat it flat on the status line). Alt+U opens it; a second Alt+U opens all usage.
- `WaitCard.tsx`: the usage wait card.
- `swaps/`: stand-ins for `ChatPlanMeters`, `UsageSection`, `TermStatusLine` and `AccountConnections`.
- `harness/`: render tooling.
  - `serve.mjs`: an in-process Vite dev server for this checkout, plus the swap and transform plugins and a fake `/api`.
  - `render.mjs`: stills. One browser, one page at a time, and a "@" scan of every shot.
  - `clip.mjs`: the motion clip, from a CDP screencast run through ffmpeg.
  - `sheet.py` and `sheets.mjs`: the labeled contact sheets (`concept.png`, `today.png`), phone crops first.
  - `guard.cjs`: preload that spawns children hidden at below-normal priority.

Run from `design/acct-trader-o/harness` (it never boots `server/index.ts` and never reads `~/.orbit`):

```
node --require ./guard.cjs --max-old-space-size=2048 render.mjs new usage-1280-github-dimmed-en,chat-390-terminal-ko
node --require ./guard.cjs --max-old-space-size=2048 render.mjs today usage-1280-github-dimmed-en
node --require ./guard.cjs --max-old-space-size=2048 clip.mjs %TEMP%\wink-ACCT-TRADER-O\motion.mp4
node --require ./guard.cjs sheets.mjs <new shots dir> <today shots dir> <out dir>
```
