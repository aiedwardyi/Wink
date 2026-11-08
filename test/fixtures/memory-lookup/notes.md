# Fixture board

## Requests

| # | What | Take | State | Status |
|---|---|---|---|---|
| 101 | Dark theme contrast pass on the settings page | Check every label against the background | Waiting on the color audit | open |
| 102 | Theme picker scrolls too far on phone | Pin the header while the list moves | Fixed in the picker sheet | done |
| 103 | Font loading flash when a theme changes | Preload only the active font | Measured 40 ms on the laptop | done |
| 104 | Speed of the first paint after sign in | Defer the sidebar avatars | Two legs still slow | open |
| 105 | Speed badge shows the wrong unit | Use ms under one second | One line fix | done |
| 106 | Test flake in the upload retry suite | Fake the clock instead of waiting | Green for a week | done |
| 107 | Test account for the billing page | Use the sandbox plan | Needs a shared login | open |
| 108 | Work laptop cannot reach the relay | Tailscale ACL was stale | Updated the tag | done |
| 109 | Work notes export as one file | Zip per bot instead | Parked until asked | idea |
| 110 | PC switch loses the open draft | Save drafts per device | Sync reads them on focus | done |
| 111 | PC name shows blank in settings | Fall back to the host name | Shipped | done |
| 112 | Credit card field rejects spaces | Strip spaces before the check | Shipped | done |
| 113 | Referral credit banner placement | Bottom of the plan page | Waiting on copy | idea |
| 114 | Usage limit banner repeats | Show once per reset | Shipped | done |
| 115 | Sidebar grows past the window on small screens | Scroll the list, pin the footer | Fixed | done |
| 116 | Row height grows when a long name wraps | Clamp to two lines | Fixed | done |
| 117 | 200+ themes over time without replacing, for people who like to browse | Themes are tiny (CSS + 20-55 KB fonts), so built-in packs under More themes, fonts load only when on | 11-08 his rule: never hide or remove a theme | idea |
| 118 | Only the owner can rename a group | Check the role on the server | Shipped | done |
| 119 | Only one composer draft per thread | Key drafts by thread id | Shipped | done |
| 120 | Moves between folders lose the sort | Keep sort per folder | Parked | idea |
| 121 | Message moves to the wrong thread on retry | Send id decides the thread | Fixed | done |
| 122 | Nightly backup misses the attachments folder | Add it to the list | Shipped | done |
| 123 | Nightly digest arrives twice | Dedupe by date | Fixed | done |
| 124 | Eval page shows stale numbers | Read from the newest run | Fixed | done |
| 125 | Eval rows need a clearer winner | Bold the better side | Waiting on design | open |
| 126 | Review bot comments twice on a push | One run per commit | Fixed | done |
| 127 | Sol reviews skip draft PRs | Run on ready for review only | By design | done |
| 128 | API key field needs a show button | Eye toggle like the password field | Shipped | done |
| 129 | Setup wizard asks for the engine twice | Remember the first answer | Fixed | done |
| 130 | Calendar card shows the wrong timezone | Use the device zone | Fixed | done |
| 131 | Voice note upload stalls at 99 percent | Retry the last chunk | Fixed | done |
| 132 | Image paste drops EXIF rotation | Apply rotation before upload | Shipped | done |
| 133 | Search misses Korean names | Tokenizer needs a look | Parked | idea |
| 134 | Export button hides behind the keyboard | Lift it with the safe area | Fixed | done |
| 135 | Update dialog opens behind the window | Focus it on show | Fixed | done |
| 136 | Tray icon stays after quit | Destroy it on exit | Fixed | done |
| 137 | Scheduled routine runs while asleep | Skip when the lid is closed | Parked | idea |
| 138 | Webhook card overflows on phone | Wrap the long URL | Fixed | done |
| 139 | Group mention list sorts oddly | Recent first, then names | Shipped | done |
| 140 | Copy button loses the code language | Keep the fence tag | Fixed | done |
| 141 | Attachments pile up in the temp folder | Sweep on start | Shipped | done |
| 142 | Long reply pushes the stop button off screen | Pin it to the composer | Fixed | done |
| 143 | Draft autosave spins forever offline | Stop after the first failure | Fixed | done |
| 144 | Lesson on reading the eval page first | Ten minute walkthrough | Scheduled | open |
| 145 | Report shows the wrong branch name | Read it from the pane | Fixed | done |
| 146 | Eval page next round: show which PC each row ran on; nightly speed legs move to the work PC; shipping speed up top; redesign | Hold the design until it has been used | Where-it-ran labels and speed legs on work PC go first | open |
| 147 | Worker pane title truncates | Show the nick first | Fixed | done |
| 148 | Pane list reorders on refresh | Stable sort by start time | Fixed | done |

## Promises

| What | Answer |
|---|---|
| OpenAI credit for Sol reviews (11-07 23:31) | Teacher: no setup needed, call_api /v1/responses. Starts with the next final review |
| Model picker remembers the last choice | Per bot, synced |
| Gift codes for friends | Later, after launch |
