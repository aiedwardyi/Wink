# Phone chat swipe proof

Recorded 2026-11-15. Before: unchanged `6259193ea` in a separate detached worktree. After: this change, with individual source hashes in `after/source-manifest.json`.

## Protocol

Hidden muted Chromium, 392x844, dark theme, English, touch input, 4x CPU throttle. Both runs used three bots and a classic room, each with 400 stored messages. The real Show earlier control loaded all 400 into every live message cache before timing; current renderer props were checked again after each selection. No messages were sent and no provider processes ran.

Each run recorded six tap switches, slow held drag, fast flick, two repeat drags, short return, end rubber band and bot-to-room traversal. The after run also covered room-to-bot, rightward room traversal and cancellation. One browser ran at a time behind the 6 GB RAM and shared lock gates.

## Frame and switch results

Frame cells: count >16.7 ms / count >33 ms; maximum interval in ms. Raw drag includes preparation. Landing includes the spring, activation and cleanup. These are RAF observations with tracing and video enabled, not compositor presentation timestamps. The 16.7 ms threshold is sensitive to timer rounding.

| Gesture | Drag before | Drag after | Landing before | Landing after | Release to interactive before/after ms |
|---|---:|---:|---:|---:|---:|
| slow-left | 34/0; 16.8 | 35/1; 100.0 | 17/6; 666.7 | 20/1; 49.9 | 901.9 / 351.8 |
| fast-flick | 1/0; 16.7 | 2/1; 100.1 | 11/5; 550.0 | 24/1; 50.0 | 775.2 / 346.8 |
| repeat-left-1 | 10/0; 16.8 | 24/1; 100.0 | 14/6; 549.9 | 19/1; 50.1 | 779.3 / 323.6 |
| repeat-left-2 | 14/0; 16.8 | 14/1; 83.3 | 13/6; 549.9 | 16/1; 49.9 | 789.4 / 331.8 |
| short-return | 8/0; 16.8 | 9/1; 83.3 | 10/0; 16.8 | 5/0; 16.8 | 153.7 / 167.1 |
| last-rubber-band | 10/0; 16.8 | 12/0; 16.8 | 11/0; 16.8 | 11/0; 16.8 | 174.9 / 191.7 |
| bot-to-room | 13/0; 16.8 | 12/1; 66.6 | 14/6; 550.0 | 15/1; 50.0 | 784.3 / 343.0 |
| room-to-bot | n/a | 13/1; 100.0 | n/a | 11/1; 66.7 | n/a / 342.6 |
| bot-to-room-right | n/a | 19/1; 66.7 | n/a | 11/1; 49.9 | n/a / 334.0 |
| room-to-first | n/a | 23/2; 100.0 | n/a | 14/1; 50.0 | n/a / 321.6 |
| cancel | n/a | 16/1; 100.0 | n/a | 9/0; 16.8 | n/a / 195.4 |

Tap median: 775.8 ms before, 254.5 ms after.

Slow-drag estimated missed RAF ticks: drag 0 before / 5 after; landing 46 before / 2 after. This estimate does not establish dropped compositor frames.

The initial cached-neighbor mount still has a measurable cost. Core first-transform latency is 137-200 ms after versus 43-98 ms before, measured from touch dispatch setup. The after run has one 83-100 ms raw drag interval spanning the first transform; subsequent intervals starting after that transform have no >33 ms gap. The before run has no cached neighbor to mount during drag. This is a startup tradeoff, not a zero-jank claim.

In the four bot switching samples, the after landing interval >33 ms starts 300-317 ms after release, after the 260 ms spring. The baseline has a 550-667 ms stall starting about 33 ms after release. At base, src/lib/use-phone-swipe.ts:128-130 selects immediately and lines 70-76 start another enter. The trace attributes the resulting stall to selection-time ChatView mounting, transcript rendering and synchronous layout. The after trace still attributes initial preparation layout to usePhoneHeaderNameFloor and transcript pinning; steady drag writes only the carrier and existing menu rider transforms.

## Quiet-slot re-measure (2026-11-17)

Home PC quiet slot, two back-to-back pairs, before `6259193ea` vs after `a0c911cfa`, same protocol. Core gestures (slow-left, fast-flick, repeat-left-1/2):

- First transform: before 42.6-103.6 ms, after 40.5-99.8 ms.
- Drag intervals >33 ms: before 0 in every gesture; after one 33.3-33.4 ms interval (one missed RAF tick) in 3 of 4 gestures, in both pairs.
- Landing max: before 450-500 ms, after 50-67 ms. Every flick lands.
- Tap median 670 ms before, 240-253 ms after. Vertical start median 62.8 / 57.6 ms before, 74.5 / 51.2 ms after (3 samples each).
- Both after runs logged two HTTP 500s from `POST /api/bots/b/prewarm` (arrived with the review-base merge, not the peek).

## Implementation and cost

A cached neighbor uses the real view under an inactive context. Two stable page keys retain the incoming DOM through the existing spring, then activate it and release the outgoing page. No second enter runs. Compact phone tails start at four cached rows and double locally until the viewport fills; older cached rows remain reachable before network paging. Desktop keeps its existing transcript size, including on resize. Header measurement no longer inserts a cloned layout tree, viewport snapshots avoid commit-time width reads, and supported phone textareas use native field sizing.

The held bot peek adds about 309 DOM nodes and 0.6-1.3 MiB used JS heap in the core samples. Slow-held browser private bytes rise about 9 MiB; private bytes measure process commit, not physical working set. After landing, one page remains and used heap is within about 0.1 MiB of the prior sample. Repeated/cancelled peeks release the extra DOM. A single joined-room cache retains at most 200 entries. No idle neighbor view or provider prewarm is created.

## Correctness evidence

- Red first on the exact base: 16 assertion failures / 4 passes for peek, order and seamless land. Additional viewport, tail-follow and slop tests were observed red before their fixes.
- 32 focused suites: 718 unique tests pass. Scheduling and review checks re-ran the hook, App and real-renderer cases without double counting. TypeScript and isolated production builds pass.
- Both final browser runs: zero page, console or HTTP errors. Six real header fit cases cover short, long and Korean names with theme and Verdana fonts; ten composer cases cover phone and desktop sizing.
- Classic and joined rooms: order, title swipes, bell guard/toggle, announcement guard/fold, bubble-only Reply/Translate, gap-only page gesture, cold header/empty background without detail fetch, cached preview without read, retained incoming DOM, scrollback, reversal, cancellation, vertical lock and reduced motion.
- Fresh phone reload followed by desktop resize restores the normal window at the bottom; desktop drag does not page. The member reorder hook named by the card is absent at this base.

The native captures are from the feature commit before the final compatibility corrections. The later production diff only adds a fallback comment and an equivalent optional neighbor access; the other changes update test fixtures and source contracts. The corrected call fixture exercises Korean locale changes through the production provider.

## Artifacts and limits

Local evidence: `D:/wink/scratch/chat-swipe-peek/evidence`. Final `before/` and `after/` contain metrics, trace, source maps, source hashes, full original videos, held/landed stills and per-action clips. `comparison.json` includes RAM/DOM deltas; `clip-index.json` records exact source offsets. Older folders are diagnostic candidates, not final proof.

Joined-room HTTP fixtures exercise the production App, renderer and gesture hooks; they do not prove remote transport. The isolated server returns empty terminal pane counts because no native bridge is present. PushManager is removed only in the throwaway phone to exercise local bell toggling. All owned browser/server processes were cleaned up normally; no foreign jobs or protected motion/bell files were changed.
