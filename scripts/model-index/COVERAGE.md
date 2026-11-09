# Model Index refresh, 2026-11-09

Each chart uses the newest version its source publishes, quoted, and a model the source does not publish stays a gap. 203 values changed and 29 were added. Older versions stay as inactive history, byte-for-byte apart from `active: false`.

- Intelligence Index moved from v4.3.2 to [v5.0.1](https://artificialanalysis.ai/models), with cost per task from the same record. AA no longer publishes v4.3.2.
- FrontierCode moved from 1.1 to [2.0](https://artificialanalysis.ai/evaluations/frontiercode-2-0). Costs were not backfilled. Cognition publishes 1.1 at most, so its fills stay in the 1.1 history.
- [GDPval-AA v2.1](https://artificialanalysis.ai/evaluations/gdpval-aa) Elos moved and GPT-6.1 Terra gained four efforts. AA no longer publishes run cost, so all costs were removed and the chart is Ranked only.
- Rams Index 0.6.1 republished its scores under the same edition and date. The previous numbers are in `rams-index-2026-11-03.json`.
- Vals moved to 2026-11-05: Opus 5.5 and Sonnet 5.5 costs changed on both boards, scores did not.
- Terminal-Bench 4.0 and list prices were re-read with no change. Google's pricing page is now Markdoc, which the parser reads.

AA numbers come from its public model pages, one per effort. The keyed weekly run now reads the Intelligence Index version from the public page and stops that chart on a mismatch.

| Chart | Missing before | Missing after | Newly missing | Still missing |
| --- | ---: | ---: | --- | --- |
| Intelligence Index 4.3.2 -> 5.0.1 | 1 | 2 | Claude Fable 5 | Claude Fable 5, Muse Spark 1.3 Contributor |
| FrontierCode 1.1 -> 2.0 | 1 | 2 | Claude Fable 5 | Claude Fable 5, Muse Spark 1.3 Contributor |
| Terminal-Bench 4.0 | 1 | 1 | - | Muse Spark 1.3 Contributor |
| GDPval-AA 2.1 | 1 | 1 | - | Muse Spark 1.3 Contributor |
| Rams Index 0.6.1 | 3 | 3 | - | Grok 4.6, Muse Spark 1.3, Muse Spark 1.3 Contributor |
| CyberBench 1.1 | 3 | 3 | - | Claude Fable 5, GPT-6.1 Terra, Muse Spark 1.3 Contributor |
| Legal Research Bench 1 | 1 | 1 | - | Muse Spark 1.3 Contributor |
| List prices | 0 | 0 | - | - |
| Total model/chart gaps | 11 | 13 | | |

Counts use the 15 picker models and active charts only. GPT-6.1 Terra and Sol both show on 6 of 7 score charts.

# Model Index fill, 2026-11-03

Design now uses [Rams Index 0.6.1](https://www.rams.ai/index), published 2026-10-29 and checked 2026-11-03: 12/15 picker models with published generation cost per page and 95% intervals. WebDev's 14/15 snapshot and filled Terra row remain inactive history, byte-for-byte apart from `active: false`. Security stays CyberBench 1.1 at 12/15: no verified 14/15 alternative or compatible missing-model fill was found. See `SEC-DESIGN.coverage.md` beside the card for the wider source audit.

Legal now uses [Vals Legal Research Bench v1](https://www.vals.ai/benchmarks/legal_research), published 2026-10-29 and checked 2026-11-03: 14/15 picker models, with only Contributor untested. Weekly refresh fetches `vals-legal-research.json`. The builder skips snapshots marked `active: false`; `vals-legalbench.json` keeps the LegalBench rows below as history. FrontierCode fills remain active; WebDev fills are retained in inactive history.

15 published values added across 3 charts. No estimated scores. Counts below use the 15 picker models; retired GPT-5.6 Terra was not added.

| Chart | Missing before | Missing after | Values added |
| --- | ---: | ---: | ---: |
| LegalBench 1 | 9 | 8 | 1 |
| FrontierCode 1.1 Main | 4 | 1 | 13 |
| CyberBench 1.1 | 3 | 3 | 0 |
| WebDev | 2 | 1 | 1 |
| GDPval-AA 2.1 | 1 | 1 | 0 |
| Intelligence Index 4.3.2 | 1 | 1 | 0 |
| Terminal-Bench 4.0 | 1 | 1 | 0 |
| List prices | 0 | 0 | 0 |
| Total model/chart gaps | 21 | 16 | 15 |

## Filled values

Efforts and precision match the source. Cognition rows use `new_score` on **Main**, never Extended or the correctness-only score. Harnesses remain on the rows. Costs were not backfilled.

| Chart | Model | Effort | Score | Date | Source |
| --- | --- | --- | ---: | --- | --- |
| FrontierCode 1.1 | Claude Fable 5 | low | 48.01 | checked 2026-11-03 | [Cognition data](https://cognition.com/data/frontiercode-leaderboard/data.json) |
| FrontierCode 1.1 | Claude Fable 5 | medium | 49.82 | checked 2026-11-03 | [Cognition data](https://cognition.com/data/frontiercode-leaderboard/data.json) |
| FrontierCode 1.1 | Claude Fable 5 | high | 52.73 | checked 2026-11-03 | [Cognition data](https://cognition.com/data/frontiercode-leaderboard/data.json) |
| FrontierCode 1.1 | Claude Fable 5 | xhigh | 53.48 | checked 2026-11-03 | [Cognition data](https://cognition.com/data/frontiercode-leaderboard/data.json) |
| FrontierCode 1.1 | Claude Fable 5 | max | 51.57 | checked 2026-11-03 | [Cognition data](https://cognition.com/data/frontiercode-leaderboard/data.json) |
| FrontierCode 1.1 | Grok 4.6 | low | 40.11 | checked 2026-11-03 | [Cognition data](https://cognition.com/data/frontiercode-leaderboard/data.json) |
| FrontierCode 1.1 | Grok 4.6 | medium | 46.06 | checked 2026-11-03 | [Cognition data](https://cognition.com/data/frontiercode-leaderboard/data.json) |
| FrontierCode 1.1 | Grok 4.6 | high | 48.01 | checked 2026-11-03 | [Cognition data](https://cognition.com/data/frontiercode-leaderboard/data.json) |
| FrontierCode 1.1 | GPT-6.1 Terra | low | 36.3365333333333 | checked 2026-11-03 | [AA FrontierCode 1.1](https://artificialanalysis.ai/evaluations/frontiercode) |
| FrontierCode 1.1 | GPT-6.1 Terra | medium | 43.7161666666667 | checked 2026-11-03 | [AA FrontierCode 1.1](https://artificialanalysis.ai/evaluations/frontiercode) |
| FrontierCode 1.1 | GPT-6.1 Terra | high | 37.1596 | checked 2026-11-03 | [AA FrontierCode 1.1](https://artificialanalysis.ai/evaluations/frontiercode) |
| FrontierCode 1.1 | GPT-6.1 Terra | xhigh | 41.3522333333333 | checked 2026-11-03 | [AA FrontierCode 1.1](https://artificialanalysis.ai/evaluations/frontiercode) |
| FrontierCode 1.1 | GPT-6.1 Terra | max | 36.025 | checked 2026-11-03 | [AA FrontierCode 1.1](https://artificialanalysis.ai/evaluations/frontiercode) |
| LegalBench | GPT-6 Astra | all | 87.1 | checked 2026-11-03 | [Z.ai comparison](https://z.ai/blog/glm-legal) |
| WebDev | GPT-6.1 Terra | max | 1672.6547058209349 | checked 2026-11-03 | [LMArena dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/viewer/webdev/latest) |

Z.ai's October 12 comparison publishes the LegalBench number in its chart and credits Vals for the evaluation. The row is marked `vendor`, with its own source label. It has no published run cost, so it appears in Ranked. WebDev's source snapshot is dated October 28. Neither source gives a run date; both fills use the checked date.

## Remaining gaps

No matching primary-source score was found for these model/chart pairs. They stay empty. The all-16-model source catalog has one additional gap: retired GPT-5.6 Terra on FrontierCode.

| Chart | Still missing | Checks |
| --- | --- | --- |
| LegalBench | Claude Opus 5.5, Sonnet 5.5, Haiku 5.5, Muse Spark 1.3, GPT-6 Luna, GPT-6.1 Sol, GPT-6.1 Terra, Muse Spark 1.3 Contributor | [Full board](https://www.vals.ai/benchmarks/legal_bench), individual Vals model pages, vendor reports |
| FrontierCode 1.1 | Muse Spark 1.3 Contributor | [AA legacy board](https://artificialanalysis.ai/evaluations/frontiercode), [Cognition board](https://cognition.com/frontiercode), [Meta model documentation](https://dev.meta.ai/docs/models) |
| CyberBench 1.1 | Claude Fable 5, GPT-6.1 Terra, Muse Spark 1.3 Contributor | [Full board](https://www.vals.ai/benchmarks/cyber), [Fable model page](https://www.vals.ai/models/anthropic_claude-fable-5), [Terra model page](https://www.vals.ai/models/openai_gpt-6.1-terra) |
| WebDev | Muse Spark 1.3 Contributor | [LMArena dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/viewer/webdev/latest), [Meta model documentation](https://dev.meta.ai/docs/models) |
| GDPval-AA 2.1 | Muse Spark 1.3 Contributor | [AA model records](https://artificialanalysis.ai/models), [Meta model documentation](https://dev.meta.ai/docs/models) |
| Intelligence Index 4.3.2 | Muse Spark 1.3 Contributor | [AA model records](https://artificialanalysis.ai/models), [Meta model documentation](https://dev.meta.ai/docs/models) |
| Terminal-Bench 4.0 | Muse Spark 1.3 Contributor | [AA model records](https://artificialanalysis.ai/models), [Meta model documentation](https://dev.meta.ai/docs/models) |

[Vals' Jev report](https://www.vals.ai/blogs/independent-evaluation-of-jev) measures a 12-subtask LegalBench slice and says it is not representative of the full benchmark. Those numbers were excluded. Legal Research Bench, LegalReasonBench, FrontierCode Extended, FrontierCode 2.0 and Intelligence Index 5.0 were also excluded. Contributor mode was not assigned another endpoint's scores.

## Refresh and dates

- `score_date: { date, kind }` distinguishes `published` from `checked`. Checked dates mean the day the source was read, never a run date or model release date.
- Checked dates show `as of <Mon YYYY>` in English and `<YYYY년 M월> 기준` in Korean. Published dates show the published month.
- `source_label` overrides the snapshot label when a fill comes from another publisher. The benchmark and effort remain unchanged.
- Fetchers preserve filled model/effort rows absent from a later response or newer than that response's published date. A newer real score replaces them. Version changes cannot carry fills into another benchmark variant.
- Historical rows do not hold back the current snapshot's checked date. GDPval and FrontierCode remain manual checks under WEEKLY.md.
