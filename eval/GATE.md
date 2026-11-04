# Memory cleanup ship gate (DESIGN.md section 7, bars from CLEAN-DESIGN-2)

**Gate: PASS (CLEAN-CODEX-RERUN, owner OK 11-04 bars unchanged).** The one authorized Codex/Codex rerun lands honest at 18/18 and catches sabotage at 16/18. Haiku/Haiku already passes. Row 2 and the remaining required rows retain their recorded passes; row 4 remains deferred. The original Codex 17/18 failure and prior execution incident remain recorded below.

## CLEAN-CODEX-RERUN
- Same stack **4b238d38ec69126d7250d94b7e372ff8e92ae46e**, pins, fixed lists, product model/effort and same-family harness. One fresh pair, no retries, no bar or product changes. Original outputs preserved.

| Pair | Honest | Sabotage | Real tokens | Result |
|---|---|---|---:|---|
| Codex/Codex rerun | Landed, 18/18, wrong 0; 28,873 tokens, 2 calls | Rejected at recall, 16/18, wrong 2; 26,021 tokens, 2 calls | 54,894 | PASS |

- Honest has no failing questions or factual null replies. Sabotage fails q1 and q3, both changed questions with non-null answers rejected by the grade call. Each variant returns the two expected absent-answer nulls: four expected nulls total, zero unexpected nulls or format failures.
- Spent **54,894/70,000 tokens in 4 real calls**. Every call recorded a RAM admission; minimum 16.52 GB free. Sabotage reuses only this rerun's honest questions reply, as the unchanged pair harness specifies. All four engine calls are fresh.
- Exported stack: all 660 files verified against Git blobs before import. Home and OMB_DATA_DIR set before Node starts and verified in scratch. One owned Node process, 2 GB cap, native engine executable. Existing processes untouched; no live .orbit access, tests, server boot or recovery work. Scratch retained at %TEMP%\wink-CLEAN-CODEX-RERUN.
- Scratch-only harness plumbing redirects scratch/output paths, records RAM admissions, resolves the stack SHA from clean-eval and imports its byte-exact export. Dependency resolution uses existing clean-eval node_modules without changing its junction. Pair logic, prompts and grading are unchanged.
- Evidence: side-file/out/4b238d3-codex-same-rerun/ (pair.json, analysis.json, preflight.json, spent.jsonl, ram-admissions.jsonl, per-variant usage and manifest). Raw prompts/replies and the fresh question cache stay in scratch. Historical honest landing totals including this sample: Haiku 3/4, Codex 4/5.

## CLEAN-SHIPFIX (owner OK 11-04)
- Prompt **621267b4cddf26c0ed78eaf05cf5132557e965cb**, pushed to checkpoint/feat/clean-prompt. Changes: only claudeAgent/codex in either role; retire rejects pending, parked, await/awaits/awaiting, 대기 and 보류 as protected. Replace remains allowed. Duplicate pending lines are also protected from retire.
- Regression tests on base 057579fd: **11 failed, 59 passed**. Final prompt targeted tests: **258/258 in 11 files**, one Node with one worker thread, no file parallelism, 2 GB cap. `pnpm run typecheck`: clean after one annotation-only fix for baseline TS7053 in memory-clean-recall.test.ts:197. No production recall logic changed.
- Rebuilt local eval/stack from checkpoint/review-base **4ea87621cafc5008fb83effbf2f7f2924d6827f7**, then merged checkpoint/feat/clean-sync **39e4dda253946b82f6d67aed248d7c8e5828ac3b**, checkpoint/feat/clean-prompt **621267b4cddf26c0ed78eaf05cf5132557e965cb**, and feat/clean-eval **c587bce38368124be27e868cb522e8689a9427f1**. Result **4b238d38ec69126d7250d94b7e372ff8e92ae46e**. Upstream unset; stack never pushed. Previous stack 9a3052d0 remains the source of the retained row 2 samples.
- Stack root typecheck: clean (`tsc --noEmit -p .`). Stack targeted tests: **264/264 in 12 files**, including the six sync cases. Validator row 9 rerun: **30/30**, fixtures unchanged. Other full gate rows were not rerun.
- Same-family pair uses the original pins (MEMORY.md 742dd9f8, queued e1f3f4a4), fixed lists and product models at low effort. The proposer also asks and grades; its own family answers. Honest and sabotage share the same questions, as in the original pair harness. Separate same-family result/cache paths prevent reuse of other-family runs. No live memory was used for the eval.

| Pair | Honest | Sabotage | Real tokens | Result |
|---|---|---|---:|---|
| Haiku/Haiku | Landed, 18/18, wrong 0; 18,036 tokens, 2 calls | Rejected at recall, 16/18, wrong 2; 10,214 tokens, 2 calls | 28,250 | PASS |
| Codex/Codex | Not landed, 17/18, wrong 1; 28,801 tokens, 2 calls | Rejected at recall, 15/18, wrong 3; 26,064 tokens, 2 calls | 54,865 | FAIL |

- Codex honest q6 (changed) returned null; its factual key is present in the answer prompt (key SHA-256 prefix bf4b0c03c646). The honest merge retains both original lines. This is a fail-closed answerer miss, with no demonstrated fact loss; the required honest-land bar still fails. No grade call was needed. Sabotage additionally fails q3 (changed, null answer); no memory text is reproduced here.
- **Spent 83,115/150,000 tokens in 8 real calls.** Stop here; no rerun. Evidence: side-file/out/4b238d3-claude-same/pair.json, side-file/out/4b238d3-codex-same/pair.json, validator/out/4b238d3/summary.json. Usage and verification evidence: sync/out/4b238d3-shipfix/.
- **Execution incident:** the initial targeted Vitest thread invocation bypassed its worker-local Windows home redirection and reached live .orbit data. Service setup attempted live bot deletion; SQLite locks caused 13 test failures. Read-only metadata found 23 workspaces recreated during that invocation, including an active bot. Previous memory contents may have been lost. There is no before snapshot proving the extent. No recovery edits or process stops were attempted. Later test invocations pass a scratch home before Node starts; a parent/worker probe confirms isolation. Do not claim live files stayed untouched. This incident makes task delivery FAIL independently of the technical gate HOLD.
- Source change sizes: memory-clean-app.test.ts +15/-2; memory-clean-app.ts +1/-1; memory-clean-recall.test.ts +1/-1; memory-clean-validate.ts +1/-0; memory-clean.test.ts +7/-0. No file over 2,000 lines grew.

## Stack (CLEAN-REGATE, historical)
- Local branch `eval/stack`, never pushed, upstream unset. checkpoint/review-base **`06284096`** (moved from a6075cd6 with #984 to #988; no memory files touched), then `git merge --no-edit` of checkpoint/feat/clean-sync **`39e4dda2`** and checkpoint/feat/clean-prompt **`057579fd`** (carries CLEAN-PARSE `65315fd6` and CLEAN-BUDGET `057579fd`), then feat/clean-eval **`c587bce3`** for the sync test. Result: **`9a3052d0`**. Every row, tsc and the targeted tests ran on it.
- Changes since the last stack (05e5d4cd): memory-clean-engine, -recall, -call, -types and -app, plus drivers/claude.ts, codex-text.ts and the new text-usage.ts. Unchanged: memory-clean-validate.ts, memory-clean-format.ts and turn-context.ts. memory-clean-types.ts only widens `TextCall` to `string | { text, tokens? }`.
- Product pairing on every real call. The proposer is `claude-haiku-5-5` at effort low, or `gpt-6.1-sol` at effort low. It also writes the questions and the grade. Answers come from the other family (memory-clean-app.ts:41). Every cleanup TextCall returns `{ text, tokens }` from the CLI's own usage, as the app's `textCall` does now. The harness counts tokens the way drivers/text-usage.ts does: Claude counts input, cache creation, cache read and output; Codex counts input and output. Calls run in blind CLI sessions: scratch config, no tools, no memory, no workspace.
- `npx tsc --noEmit -p .` on 9a3052d0: exit 0. Targeted vitest, one process (`--no-file-parallelism --no-cache --configLoader runner`, Node 2 GB): **16 files, 309/309 pass**. The files: memory-clean, -app, -budget, -edges, -recall, -routes, -service, memory-clean.sync, memory-sync, google-sync, -join, -move, -republish, bot-routes.memory, drivers/claude-text, drivers/codex-summary. Logs: eval\sync\out\9a3052d.

## Rows
| # | Row | Data | Bar | Measured (9a3052d0; 4b238d38 where noted) | Result |
|---|---|---|---|---|---|
| 1 | Side-file recall | QTIDY-EVAL 40 Q + pinned pair; fixed honest/sabotaged merge pair per family | Owner OK 11-04: every landed run meets STAYED/CONTROL/MIXED/SUPERSEDED HIGH, ABSENT 3/3, wrong 0; MOVED ungated. Each engine lands >=50% of honest runs. Fail-closed = not landed. Honest pairs land and sabotage is caught, including same-family | 9a3052d0: Codex landed, required buckets all correct, 39/40 overall with one MOVED miss; Haiku side-file not landed (17/18). Other-family pairs pass both (honest 18/18, sabotage 16/18). 4b238d38 same-family: Haiku honest 18/18 landed, sabotage 16/18 caught; Codex honest 17/18 not landed, sabotage 15/18 caught. CLEAN-CODEX-RERUN on 4b238d38: Codex honest 18/18 landed, sabotage 16/18 caught. Across rules, side-file and honest pairs including the rerun: Haiku 3/4 landed, Codex 4/5 landed | **PASS** (authorized same-family rerun passes) |
| 2 | Main-file recall | Same pinned REVIEW 20 Q, 3 AFTER + 2 BEFORE; rows 15 and 20 dropped from scoring and reported apart | Owner OK 11-04: (a) no row right in any BEFORE and wrong in every AFTER; (b) any AFTER miss on a changed line is loss, and at least one changed line is exercised; (c) median AFTER >= median BEFORE; (d) re-key or drop standing BEFORE misses and report apart | (a) none. (b) no changed-line miss; REVIEW row 4 keys on retired queued:138 and is correct from history in 3/3 AFTER. (c) scored 18 rows: AFTER 16/18, 18/18, 18/18; BEFORE 18/18, 18/18; medians 18/18 each. Rows 10 and 18 only miss in AFTER 1, on unchanged source lines. (d) dropped rows 15 and 20 fail in all 5 original samples. Rows 16 and 19 correct 5/5. Haiku row 2 remains not exercised. Follow-up 2 reason-line caveat retained below | **PASS** (owner-approved paired bar; 0 lost facts) |
| 3 | Rules | rules/fixture/MEMORY.md (invented, 22,900 B, 176 lines; 10 pairs, 10 protected, 10 dupes), full run | newer ≥9/10, protected 10/10, dupes ≥8/10, LANDED, on Haiku and Codex | **Haiku:** landed, 10/10, 10/10, 10/10, lost 0, recall 18/18 with no grade call. 22,900 → 21,172 B, 176 → 157 lines, 2,695 changed chars. 49,375 tokens (propose 20,618 + 13,538, answers 15,219). **Codex:** landed, 9/10, 10/10, 9/10 (missed pair key 릴리스 브랜치 and dupe #tw-crash), lost 0, recall 18/18 with one grade call. 22,900 → 21,146 B, 158 lines, 1,890 changed chars. 58,262 tokens (propose 18,854 + 17,016, answers 10,208, grade 12,184). | **PASS** |
| 4 | Live recall | MEMORY-SIM, cleanup forced after S2 | ≥ baseline mean (21/25); stale, invented, secret 0 | Not run, per CLEAN-REGATE. Estimate for one run: about 1.75M tokens. Pilot 3 was 1.69M (about 13 min), plus one forced cleanup: MEMORY.md runs measured 49k to 58k here, and a side-file run 74k to 88k. The row as designed (2 cleanup runs against 2 baseline runs) is about 7M. | **Deferred, Wink decides** |
| 5 | Engines | Rules, side-file, recall and honest/sabotaged pairs on Haiku and Codex | Owner OK 11-04: corrected rows 1-3 bars; same-family honest lands and sabotage is caught on both | Required landed buckets and paired row 2 pass. Haiku same-family pair passes. Original Codex same-family honest fails closed at 17/18; CLEAN-CODEX-RERUN lands honest at 18/18 and catches sabotage at 16/18. Both engines pass their same-family pair | **PASS** |
| 6 | Tokens | engines' own usage on every cleanup run; his MEMORY.md as a read-only scratch copy (re-pinned 74d5a968, 23,597 B) | ≤60k per MEMORY.md run, ≤120k per side-file run, ≤8,000 changed chars; his file ends "nothing", or every landed change passes recall with wrong 0 | MEMORY.md runs: 14,672, 18,421, 49,375 and 58,262 (max 58,262, 97% of the cap). Side-file runs: 87,635 and 74,251 (max 87,635). Changed chars: max 2,695 (rules Haiku); the landed side-file run changed 232 (MEMORY.md 95 + queued 137). His file: "nothing" on both engines (Haiku 14,672; Codex 18,421), 23,597 → 23,597 B. Every reminder fit in 8,000. | **PASS** |
| 7 | Turn latency | turn prompt built as index.ts does (memorySystemPrompt, sessionPromptFor, withSystemChanges, systemTurnInput), 20 before and 20 after a real landed run (rules, Codex) | p95 within 50 ms; 0 "system" restarts; 0 turns waiting on cleanup | p95 0.89 → 1.43 ms (+0.54). Restarts: 0 in the probe and 0 across all 3 landed runs. Awaited turn-path sites: 0. index.ts:3284 and :4457 `turnStarted()`, :3407 and :2194 `check()` and :3033 `start()` are all synchronous; :7859 awaits only the Undo HTTP route. The helper's new JSON output format applies only when `onUsage` is passed (memory cleanup); turns never call it. Turn-abort tests pass in the targeted run. | **PASS** |
| 8 | Sync (rerun: cleanFiles in memory-clean-engine.ts, plus memory-clean-call.ts and -types.ts on the harness path through createMemoryClean, changed) | server/memory-clean.sync.test.ts on google-sync-pc.ts, 6 cases | 0 lost lines; 0 conflict copies; 0 duplicate archive blocks; profile-sync.json and Google binding byte-identical | 6/6 on 9a3052d0 (each case asserts lost 0, copies 0, dup 0 and both files identical on every PC). | **PASS** |
| 9 | Validator (rerun: memory-clean-validate.ts changed) | Original 30 bad change lists and 3 bases, unchanged | 30/30 rejected with expected reason | 4b238d38: 30/30 rejected with expected reason, 13/13 RejectReasons, fixture self-check empty | **PASS** |

This is the prep-time stand-in for send-to-engine time: row 7 times the turn-prompt build that index.ts does before it sends, with no server boot.

## Findings for CORE (CLEAN-REGATE, historical)
No row failed on a code bug. CLEAN-PARSE and CLEAN-BUDGET fixed what the last gate found: every reply parsed, and code decided 17 or 18 of 18 on every run. The Codex rules run reached its grade call under real usage (46,078 + 12,184 = 58,262 ≤ 60,000) and landed.
1. **Answerer misses still block side-file runs** (row 1, Claude). The miss was a different word from the right line, and the key was in the answerer's prompt. Landing needs 18/18, so one answerer slip drops the whole run. That is by design, and no small code fix exists. A clearer questions prompt (one asked value per line) might help, but that is a prompt choice for CORE.
2. **Main-file misses are not cleanup losses** (row 2, Codex). All 4 missed rows sit on lines the cleanup did not change. The live harness-gotchas and release-flow changed since the last pins (the bot wrote release-flow.md at 14:54 during the copy). The REVIEW.md gold may now lag the files. Settling this needs a BEFORE pass on the same pins (about 94k tokens).
3. **Codex's MEMORY.md runs sit at 97% of the 60k cap** (58,262). Counting real usage makes the grade call affordable, but there is little headroom: a slightly larger file or one more grade pair would stop at budget.

## Harness notes (CLEAN-REGATE)
- Scratch is now %TEMP%\wink-CLEAN-REGATE (lib/util.mjs). lib/engines.mjs keeps a run-wide ledger (scratch spent.jsonl). It refuses any call whose bound (prompt bytes/2.4 + 16k) would pass 500k.
- Re-pinned: main-file harness-gotchas 3210fc38 → 70857885 (38,898 B) and release-flow 7d5b4508 → 3314ca34 (27,242 B); tokens his MEMORY.md abd8e5ce → 74d5a968 (23,597 B). The read-only copies sit in scratch\pin.
- rules/run.mjs: the pass flag now uses the CLEAN-EVAL-2 bar, newer ≥9/10 (it still required 10/10).
- side-file/pair.mjs now returns `{ text, tokens }` like the product's textCall, and its cached questions reply carries its tokens. Not run this time.
- Main-file ran with `--skip-before`.

## Tokens spent (CLEAN-REGATE)
464,275 of 500,000, 22 real calls, all logged in the ledger:
- Rules: 49,375 + 58,262.
- Side-file cleanups: 87,635 (Claude) + 74,251 (Codex); answer and score on the Codex run: 49,543 + 18,047.
- His file: 14,672 + 18,421.
- Main-file (Codex, after only): 78,508 + 15,561.
- Pairs and the BEFORE pass: 0 (not run, budget).

## Follow-up 1 (CLEAN-REGATE.followup-1, historical)
The two open checks, on the same stack 9a3052d0 with the same pins (MEMORY.md.bak 742dd9f8, queued.md.bak e1f3f4a4, harness-gotchas 70857885, release-flow 3314ca34, REVIEW.md b7010df3). The pins were recopied from the live files; their shas still matched. Scratch: %TEMP%\wink-CLEAN-REGATE-2. Verdicts and bars above are unchanged.

**1. Row 2 BEFORE pass.** Same 20 questions on the uncleaned files, with the same pairing as the AFTER pass: Claude Sonnet answers, Codex scores. That is the product's other-family pairing for a Codex proposer; the card's "Codex answerer" would have changed the answerer between the two passes. Result: **18/20, wrong 1**. Row 15 was stale (H:43); row 20 was missing (COLD, no source); rows 16 and 19 were correct.
- Same misses: **rows 15 and 20** fail BEFORE and AFTER. They are not cleanup loss. They also matched the last gate's BEFORE (a5841ab: 18/20, misses 15 and 20).
- **Rows 10 and 18** were correct BEFORE and wrong AFTER, but their source lines did not change. Row 10's line (queued.md:150 before, :149 after the retire of 138) is byte-identical, and the retired line 138 shares 2 of its 68 tokens. Row 18's line (MEMORY.md:15) is untouched. Both answers cited the same line in both passes. The answers stayed close: BEFORE and AFTER share 13 of 22 tokens on row 10 and 14 of 19 on row 18. Their overlap with the gold was 2 → 3 tokens on row 10 and 6 → 4 on row 18. This reads as answerer or scorer noise on one sample each, not cleanup loss. One pass per state cannot fully separate the two.
- Tokens: answer 77,845 + score 14,431 = 92,276. Output: main-file/out/9a3052d-codex/before.json (the AFTER summary is untouched).

**2. Row 1 pairs** (fixed list from CLEAN-DESIGN-2: MEMORY.md merge 109+110; queued.md retire 24, 67, 138; product pairing):
| Engine | Honest | Sabotaged | Caught on | Tokens |
|---|---|---|---|---|
| Claude (Haiku proposes, Codex answers) | landed, recall 18/18, wrong 0 (28,249) | not landed, recall 16/18, wrong 2 (16,756) | q1 and q3, both keyed on a swapped number, false in the grade call. 4 questions held a swapped number; q9 and q15 passed | 45,005 |
| Codex (Codex proposes, Haiku answers) | landed, recall 18/18, wrong 0 (34,899) | not landed, recall 16/18, wrong 2 (20,114) | q1 and q3, both keyed on a swapped number. q1 was false in the grade call; q3 got a null answer on a merged-line key, false by code | 55,013 |

Pair: **PASS on both engines.** CLEAN-EVAL-2 caught the swap on 1 question per engine; this run caught it on 2, as CLEAN-PARSE's fix intends. The sabotaged run reuses the honest run's questions reply, whose prompt is byte-identical, so the sabotaged token count leaves that call out.

**Follow-up tokens:** 192,294 of 260,000, 12 calls in the ledger (92,276 BEFORE + 45,005 + 55,013 pairs).

**What this settles:** row 1's pair half now passes on both engines. Row 1 still fails because the Haiku side-file run did not land, and row 2 still fails because the bar is 20/20 AFTER. Two of row 2's four misses already fail on the uncleaned files. The other two flip on unchanged lines. So none of the four traces to a line the cleanup lost.

## Follow-up 2 (CLEAN-REGATE.followup-2, historical)
More samples of row 2 on the same stack 9a3052d0, the same pins (recopied; shas identical) and the same 20 questions. Claude Sonnet answers and Codex scores, as in every row 2 pass. Scratch: %TEMP%\wink-CLEAN-REGATE-3. No cleanup call. Verdicts and bars above are unchanged.

**After-state for the new AFTER samples.** The landed state of run mc-20261104-e0903dad lived in the removed CLEAN-REGATE scratch, so it was rebuilt from the pins and the saved run header with no engine call. queued.md comes from the stack's `validateChangeList` (retire 138), and MEMORY.md gets the stack's `POINTER_LINE` placed as `pointer()` places it. Both after files match the run's recorded hashes (MEMORY.md bdb5e07d, queued.md 7d375f59). The history block is `archiveBlock` of the saved header and the retire entry. **One line differs:** the entry's reason (78 bytes, Codex's own text, lost with the scratch) is an 8-byte placeholder. The rebuilt answer prompt is 175,936 B against the original 176,006 B. That 70-byte gap is exactly the reason-length difference, so every other byte length matches. AFTER sample 1 is the original run; samples 2 and 3 used the rebuilt state.

| Sample | Score | Row 10 | Row 15 | Row 18 | Row 20 |
|---|---|---|---|---|---|
| AFTER 1 (REGATE) | 16/20, wrong 4 | wrong | stale | wrong | wrong |
| AFTER 2 | 18/20, wrong 1 | correct | stale | correct | missing |
| AFTER 3 | 18/20, wrong 1 | correct | stale | correct | missing |
| BEFORE 1 (follow-up 1) | 18/20, wrong 1 | correct | stale | correct | missing |
| BEFORE 2 | 18/20, wrong 2 | correct | stale | correct | wrong |

- Rows 1 to 9, 11 to 14, 16, 17 and 19 were correct in all 5 samples, including the newer rule on 16 and 19.
- **Row 10:** right in 2/3 AFTER and 2/2 BEFORE. **Row 18:** right in 2/3 AFTER and 2/2 BEFORE. Both failed only in AFTER 1, on byte-identical source lines: answerer or scorer noise.
- **Rows 15 and 20:** wrong in all 5 samples, before and after the cleanup. That is gold lag or a standing answerer miss, not cleanup loss.
- **Wrong in every AFTER but right in every BEFORE: none.**
- Caveat: AFTER 2 and 3 carry the placeholder reason line where AFTER 1 had the original. An effect from that one history line on rows 10 and 18 cannot be ruled out, but nothing points to it. Row 10's line shares 2 of 68 tokens with the retired line, and row 18 is in MEMORY.md, not queued.md.

**What this settles:** row 2 stays FAIL under its 20/20 bar, because rows 15 and 20 miss in every state. The cleanup did not cause any row 2 miss: the after-state scores the same as the uncleaned files on 2 of 3 samples, and the one worse sample does not repeat.

**Follow-up 2 tokens:** 279,191 of 300,000, 6 calls in the ledger. AFTER 2: 78,578 + 14,507. AFTER 3: 78,305 + 15,217. BEFORE 2: 76,669 + 15,915. Outputs: main-file/out/9a3052d-codex-r2, -r3 (summary, score, answers) and -b2 (before.json). Harness: main-file/run.mjs takes `--tag <t>` for a separate output folder.

## Previous runs
- CLEAN-EVAL-2 (stack 4aad6a48/05e5d4cd): FAIL. Rows 6, 7, 8 and 9 passed; rows 1, 2, 3 and 5 failed; row 4 was deferred. Haiku's questions and grade replies failed to parse, and recall misses blocked the side-file runs. The pairs passed on both engines. That run spent 424,947 tokens.
- CLEAN-EVAL (stack a5841ab/3536ddd): FAIL. Rows 7, 8 and 9 passed; rows 1, 2, 3, 5 and 6 failed; row 4 was blocked. That run spent 536,910 tokens.
