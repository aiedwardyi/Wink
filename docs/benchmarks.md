# Benchmarks

Where each number in the README's [Numbers](../README.md#numbers) table comes from. Each is one run on one Windows PC, not a lab result. The source paths are in the maintainer's private run folders (`Orbit-cards/...`); ask in an issue for the raw files.

## Launch to typing

| | |
|---|---|
| Result | Wink 1.15 s, bare Claude Code CLI 1.12 s (medians 1.146567 s and 1.124512 s) |
| Method | ADEMark v1 test A1, variant `cold`, run with a Windows port of the kit: 10 launches per side, from launch to a prompt that takes typing. Method: [TESTS.md](https://github.com/zqkra/ademark/blob/f38966f/TESTS.md) |
| Builds | Wink 1.0.269 and Claude Code 2.1.325, both on Opus 5.5 at High effort |
| Date | 2026-11-15 to 2026-11-16 KST |
| Machine | Work PC, Windows. Both sides on the same PC |
| Source | `Orbit-cards/day-1115/ade-now/report/ade-summary.json` (`A1/cold`), also `ADE-NOW.table.md` in the same folder |
| Label | Windows, same-PC multiple, ADEMark method, not verified by ADEMark |

## Memory with 20 chats

| | |
|---|---|
| Result | Wink 361 MB, bare CLI 1,000 MB (361.410 MB and 1,000.359 MB) |
| Method | ADEMark v1 test A10, variant `rest-20`: 20 threads, each seeded with one message, then 10 s of rest and a 60 s sampling window. Total memory of the app and its engine processes, as Windows private working set by process group |
| Builds | Wink 1.0.269 and Claude Code 2.1.325, both on Opus 5.5 at High effort |
| Date | 2026-11-15 to 2026-11-16 KST |
| Machine | Work PC, Windows. Both sides on the same PC |
| Source | `Orbit-cards/day-1115/ade-now/report/ade-summary.json` (`A10/rest-20`), kit step in `ade-v1/kit/drive_runs.py` (`a10`) |
| Label | Windows, same-PC multiple, ADEMark method, not verified by ADEMark |

## Model picker open

| | |
|---|---|
| Result | 136 ms before, 67 ms after [#2048](https://github.com/aiedwardyi/Wink/pull/2048) (medians 135.7 ms and 66.8 ms, n=14 each, faster in 14 of 14) |
| Method | Desktop at 1440 wide, `Alt+M` on a fresh page, timed from the key event to the end of the frame that shows the dial. Base and fix interleaved. Web build in headless Chromium 159 at BelowNormal priority on a busy PC |
| Builds | `f38325adb` (before) and `197bb3978` (#2048 head) |
| Date | 2026-11-20 |
| Machine | Home PC, Windows 11 |
| Source | `Orbit-cards/day-1120/GATE-REVIEW-2048.result.md`, raw rows in `Orbit-cards/day-1120/gate-2048/data` |
| Also | The PR's own run in the packaged app on a quiet PC: 129.5 ms to 41.2 ms ([#2048](https://github.com/aiedwardyi/Wink/pull/2048) body) |

ADEMark v1 data and method by [zqkra/ademark](https://github.com/zqkra/ademark/tree/f38966f), CC BY 4.0.
