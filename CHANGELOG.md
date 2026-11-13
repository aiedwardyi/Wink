# Changelog

All notable changes to Wink, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Earlier releases are on [GitHub Releases](https://github.com/aiedwardyi/orbit-releases/releases).

## [1.0.261] - 2026-11-13

### Added
- The model picker has a Chart style beside Dial and List: each model is a cost and intelligence line with effort stops.
- Merlot replaces the Moss theme: black cherry backgrounds, a wine accent and brighter text. A saved Moss theme switches to Merlot.
- Room bots can search their owner's 1:1 chat with them. Only the owner sees the "Searched your 1:1" note.
- New call voices: Jenn and Eddie sound new, and Adele joins with a British accent.

### Changed
- The call button lives in the message box: Call when idle, Send while typing, Stop while busy, and End with Mute beside it during a call. The header no longer has a call button.
- Picture and file menus work the same everywhere, and menus, pickers and close buttons share one hover style. On phones, Copy appears for Wink pictures and readable outside pictures.
- In team rooms, host bots name each team bot and its owner and hand off through the owner; an @name that matches no one reaches no one.
- The call voice says each reply once, stops re-offering the same change, and sticks to what the chat shows.
- Asking a busy bot in a room now waits and answers automatically, in order, once the bot is free.
- Calls, question cards and Settings open faster the first time.
- Bots know more about Wink: groups and team rooms, calls, the side pane, the To Do list and skills.
- Bot replies put gaps first, say who did or checked each thing, and quote numbers only from a source they opened.
- Worker bots follow clearer playbook rules, and their cards quote your latest words.
- The side pane button shows an arrow, like the bot list button.

### Fixed
- Linked HTML pages render in Show, and HTML files open in your default app.
- Teammates see the room's Bots again after upgrading.
- The phone Memory page shows its map with a Retry when the memory read hangs, instead of only Auto Notes and Memory File.
- Pictures teammates post in a group now reach the bots.
- Bot replies in another language are translated in team rooms.
- The Memory card scrollbar stays inside its rounded corners.
- Claude bots show Load Skills & Plugins in Bot details again.
- The Max effort rainbow is bright again on light skins.

## [1.0.259] - 2026-11-13

### Added
- Auto Notes keeps your picks: a short reply choosing among a bot's options is saved as one dated line under Decisions in MEMORY.md.
- Save and cancel buttons beside room, profile and bot name edits; Enter saves and Esc cancels.
- Question cards fold to a pill by chevron or phone swipe and reopen without answering.

### Changed
- Bots report every finished deliverable and pending decision with a picture or link, and close their own question cards once you answer in chat.
- Room details shows the invite code on one line with a Copy button.
- Bots are steered away from narrating their next step between tool calls.
- Muse uses fewer tokens: the worker playbook and five rarely used Wink tools load only when needed.
- The sidebar profile, Account and Connections tiles show from the last launch while the server starts.

### Fixed
- Dragging an image inside a chat no longer attaches it.
- A changed call voice applies from the next call, and the voice picker stays on the saved voice.
- A call whose reconnect never sets up fails with "Call failed" instead of sitting open, and a mic that stops sending recovers or asks for a tap.

## [1.0.258] - 2026-11-13

### Changed
- Views, panels and call screens open faster the first time you press them.
- Opening a chat on desktop skips a phone-only measure, so it opens a little quicker.
- Pairing a browser for the first time no longer shows the onboarding cover or blank frames; the desktop app keeps the cover.

## [1.0.257] - 2026-11-13

### Added
- Teammates bring their own bots into a team room, and only a bot's owner can ask it; hosts can add bots to a people-only room.
- Room details opens from the room name or picture, with People, Bots and Room settings in one place.
- A live call follows you across chats, rooms and settings, with a call widget in the sidebar and above the chat box; pick the call voice and language in Settings.
- Media is a month timeline with Photos and Files; save a file or show it in its folder, and hosts delete room files there.
- Rooms take video and audio files, and teammates still on 1.0.256 stay in the room when one is posted.
- The checker gets its own Check tab in the right pane, and the Show pane can save a copy of a bot file.
- Anonymous usage stats; one "Crash reports and stats" switch in Settings turns both off.

### Changed
- Reactions use Noto color emoji icons.
- The call voice talks warmer and quicker, leads with the answer, and offers work instead of promising it.
- Muse turns end sooner and use fewer tokens.
- Sign-in shows PCs as pills with the last-used one marked; desktop browsers switch PC from the sidebar's top icon.
- The Live memory card's Asks is now To Do with a Show all row; bot questions you skip are filed on the asks list.
- Chat pictures are capped at 512 x 384 and keep their size, so the chat doesn't jump.
- Turns no longer wait on the task record save or a native engine's summary build.

### Fixed
- Voice calls: every spoken order is sent or the call says it wasn't, a yes to the voice's own offer confirms, and the confirm card names the bot.
- Calls pick back up after the phone app returns from the background, or show Tap to resume.
- Bot question cards stay live until answered or dismissed, and bots no longer answer twice in one turn.
- Rooms: long catch-ups no longer cut off, teammates scroll past 200 lines, Leave works when the host is gone, lines show links, and hosts can let a removed teammate back in.
- Bot PDFs open in Show in the installed app, Korean text included.
- Chat keeps its place as new messages land, the show pane closes without reloading Media, and a double tap on Send no longer stops the turn.
- On phones, taps no longer leave a hover highlight and the Memory glow no longer shows a black box.
- Room code boxes: fixing one keeps the rest, Backspace clears one, and they don't text-select.

## [1.0.256] - 2026-11-12

### Added
- A Media tab in the right pane shows every picture and file from a bot chat or room, and a header button opens and closes the pane.
- On phone, swipe a room line right to reply or left to translate.
- Joining a room with no profile name asks for one first; members still rename themselves in People.

### Changed
- New outline icons for reactions.
- Old-pane cleanup runs in the background, so it no longer holds Wink up.

### Fixed
- Group fixes from today's audit: bots get full messages with their pictures and files, the host sees teammates' pictures and files, the room box clears at send, and replies no longer fail.
- Room files, file cards from another PC, and jumping to an old message land right.
- A teammate's name can no longer break into a room bot's prompt.
- A restored bot opens with its chat; the pinned notice keeps its text; the 6-box code works with a Korean keyboard.

## [1.0.255] - 2026-11-12

### Added
- Groups for your team: one New group, people and bots together, invite code in Members; teammates can @ your bots.
- Short 6-character room codes to share and join a room; long codes still work.
- Team room lines get emoji reactions, and a line can be pinned as the room notice.
- Deleted bots go to Recently deleted, under Archived bots: restore one or empty now; it empties itself after 30 days.
- An Asks box on the Memory page shows what you asked a bot and where each ask stands.
- Older messages load by themselves as you scroll up a chat.
- A show pane opens the pictures, PDFs and web pages your bots make.
- Three new themes: Bronze, Precision Dimmed and Dim Sand. Moss moves under More themes.
- Pick the model picker look (Dark, Light, Atelier) in Theme settings, plus Dial or List where the dial fits.
- Rooms get names, files, translate, a picture and a right-click menu with Reply and Copy.
- A soft ring while a voice call connects, and a short tone when it ends.
- On Windows, the mic by Send shows the Win+H dictate hint.

### Changed
- The team room chat box works like the 1:1 box.
- Wink opens faster: Account, Usage and Devices show real data in 10-14 seconds, and pasted pictures appear at once.
- Replies show up as soon as the bot finishes.
- Bot Details and Memory open faster.
- Checker cursors in both Watch views move faster.
- The "sent mid-turn" hover hint is shorter.

### Fixed
- Typing no longer stutters in long chats while a bot replies.
- Long member lists scroll inside their panel.
- An account hit by an API credit promo restriction says why and stops launching workers until you sign in or update the key.

## [1.0.254] - 2026-11-12

### Added
- Room alerts on phone and desktop, with a bell to mute each room.
- On a voice call, Wink reads answers, questions and worker updates aloud.
- Group menu has People and Copy invite code; room rows drag to reorder.

### Changed
- Questions and orders you say on a call always reach the bot, or the voice says they weren't sent.
- The model dial moves one model per wheel click at any zoom, and once per trackpad flick.
- The Claude icon matches the other logos in size.
- The Team page hides your own card; bar tips float over the page instead of stretching it.

### Fixed
- Your spoken answer to a question card on a call reaches the bot; "say the question again" repeats it.
- A teammate's PC waking up gets one alert per room, not dozens.
- Closing terminal panes no longer crashes the app.
- Bots no longer get flagged for note edits they didn't make.
- New worker panes no longer flash an old launch line.

## [1.0.253] - 2026-11-11

### Added
- Team rooms on your phone, with unread counts and each room's last line.
- One invite code per team room; teammates show under their own Wink name.
- Drop files into team rooms; the message box grows as you type, and drafts stay.
- A welcome card the first time you start a voice call.

### Changed
- The Devices page leads with one link; the setup code and Tailscale fold away.
- Settings, bot details and Devices open fast the first time.
- The first reply after a quiet spell comes faster.
- Voice calls stay quiet while you type and speak in your app language.
- Call captions sit on their own row above the message box and wrap.
- Browser sign-in remembers you and shows the Wink logo and Google button.
- Team snag notes read plainly and skip your own PC.

### Fixed
- End on a voice call never stops the bot, and one spoken yes does one thing.
- Phone volume keys now change the call voice.
- Removed teammates can't rejoin with the room code.
- Phone alerts close once their chat is read.
- Opening a linked folder from another PC works.
- The same account can't be added twice; the empty credit row is gone.
- The sidebar resize cursor no longer sticks after a drag.
- Startup device picks stay on Tailscale.
- Phone sign-in asks for your Google account once.
- Prepared Claude sessions no longer pile up past the memory cap or outlive a deleted bot.

## [1.0.252] - 2026-11-11

### Added
- Team rooms are on for everyone: share your room code and teammates join right away.

### Changed
- Long chats keep the numbers and values you typed, word for word, when they summarize. PINs and keys stay out.
- Quick answers while your bot is busy come faster and no longer cut off mid-lookup.

## [1.0.251] - 2026-11-11

### Added
- Voice calls in the desktop app: the phone button now shows in the chat header.

### Changed
- The memory file reads as plain text, with an Edit button at the top right.
- The model picker uses a light look on light skins.
- Quick answers now reply to greetings and quick pings while your bot is busy, and the waiting dots are gone.

### Fixed
- Voice calls work in another PC's window, and End works after a call fails.
- "Live now" reads indigo on light skins.
- The compact worker chip matches the size of its neighbors.
- The folder field explains itself when there is no Browse button.
- The whole "Show more" row is clickable.

## [1.0.250] - 2026-11-11

### Added
- Devices: one "Connect from my devices" switch per PC, a QR code for your phone right on the page, and a green check on each PC you can reach.
- Opening Wink in Chrome on a computer now gives you a real terminal: typing, arrow keys, copy and Korean all work.

### Changed
- Connections uses the same account cards as Usage.

### Fixed
- The Claude mascot's eyes and feet stay even at 125%, 150% and 175% screen scaling.

## [1.0.249] - 2026-11-11

### Added
- Voice calls with your bot: tap the phone icon at the top right of a chat. The chat stays quiet during the call, and one call card with a summary and the transcript stays after.
- Open Wink on your other PCs from Chrome with Google sign-in, no Tailscale needed.
- Bot Details and Workers share one panel on the right, and the bot list folds while it's open.
- The bot's avatar in the chat header says it opens Bot Details and memory.
- Activity squares ripple when you tap them.

### Changed
- A shorter welcome line on first run: "Give a bot a job. Check in from anywhere."
- New bots start with an empty name.
- Softer hover on chat header icons, a violet Muscle Memory icon, a darker Live now and a smoother memory glow.

### Fixed
- Wink's background checks no longer flash a terminal window on Windows.
- Bots with nothing to say stay quiet: no stray lines and no status flicker.
- The What's New card stays put until you close it.
- Dragging on the Usage page no longer grows the list, and the hand closes when you press.
- Browser connections to another PC stay alive between requests, and browser setup is clearer.
- The refresh icon finishes its turn before stopping.
- Quick answers work again after an ask card you typed past.
- A message blocked by a Grok hook names the hook.
- Code that reads a secret is no longer masked as one.

## [1.0.248] - 2026-11-10

### Added
- Wink keeps a daily backup of your chats, bots and memory in a Wink Backups folder.
- Document checks in Live Verify replay with one cursor per checker, and short files play long enough to follow.
- Alt+R refreshes usage again, in the usage popover and in Settings > Usage.

### Changed
- Live Verify checks only documents the reply or your message names, never a bot's own notes or memory.
- The bot's Description box is now called Instructions.
- After a skipped update, What's New shows the newest notes you haven't seen.
- Bots resend less context on each message, which saves tokens.
- Hitting one model's limit (like Fable) shows the limit card instead of an error.

### Fixed
- Quick answers send Korean requests and refusals to the bot, and a quick answer no longer lands after the bot's final reply.
- Deleting a bot never empties a folder linked inside it, and a damaged bot list, settings or routines file is set aside instead of overwritten. The delete warning says what goes.
- A link to a file on another PC opens from that PC, or says which PC has it.
- A failed account switch or a stopped Grok reply now says why.

## [1.0.247] - 2026-11-10

### Added
- Claude Fable 5.2 in the model pickers and the Model Index.

### Changed
- The model list shows the cost per task at the effort you pick.
- Fable 5 is no longer offered for new bots; bots already on it keep working.

## [1.0.246] - 2026-11-10

### Added
- A What's New card after an update, shown once.
- Quick answers: ask a Claude bot a short question while it works and get an answer without stopping its task.
- Live Verify checks documents bots write and fixes the problems it finds, with details a tap away.
- Live Verify checks app pages a bot names.
- Codex workers can run on a saved OpenAI API key.
- A refresh button in the usage quick view, and whole rows drag to reorder usage accounts.

### Changed
- Settings > Team counts hours only while someone is actually using Wink, not while it sits open.
- Bot names show above bot replies on wide-bubble themes, and your own messages no longer carry a "You" label.
- Smoother Memory panels and a soft brain glow; smoother motion on the newest cards and panels.
- New bots rotate through the Wink colors.
- Phones are listed under This PC in Devices, and folded usage bars are bigger on phones.
- The Model Index uses today's sources.
- Update failures show a plain, quiet message.

### Fixed
- Cleanup no longer keeps a CPU core busy for long after workers finish.
- A signed-out account is marked once and skipped for new work until you sign in again.
- Long-Term Memory shows facts written as plain lines.
- Phone text selection has drag handles and Copy, and the phone worker list scrolls again after reaching the top.
- The model picker no longer shows dark side bands at some window widths.
- Bots no longer point at a question card you closed by typing.
- Replies synced from another PC show the bot's own avatar.
- Codex bots in Ask mode no longer ask before Wink's own tools.
- Stray tags no longer show in bot replies, and quiet background wakes no longer post empty replies.
- Security and reliability fixes from release audits.

## [1.0.245] - 2026-11-09

### Added
- Phone videos get a Wink full screen button.
- Swipe between a bot's Settings and Memory, and edit Memory on your phone.
- The model dial shows the run cost at each effort.

### Changed
- The first paragraph appears as it streams.
- Long Claude chats compact at Claude's own limit.
- Precision gets wide bubbles and the Wink font.
- Usage folds are smoother, and drag handles are easier to grab, with long press on phones.
- Live Verify replays are calmer and show one cursor per checker.
- Activity squares settle with a soft glint.
- The bar repeating a pinned question is gone.

### Fixed
- The phone usage card opens at full height.
- A failed phone send survives a reload.
- Live Verify runs once.
- Connected account emails no longer open a copy on tap.
- Closed workers release their memory.
- Safer, lighter cleanup.
- A save or spawn that fails no longer loses or repeats work.
- Security hardening for paired phones.

## [1.0.244] - 2026-11-08

### Added
- A memory map on each bot's Memory tab.
- Drag to reorder group answers.

### Changed
- Profile and Sync share one photo band in Account.
- Saved keys fold into one row.
- The Activity card opens at once, shows each day on hover or tap, and counts Day Streak, Best Day and Total Replies from your first day.

### Fixed
- Phones no longer show Reconnecting on a normal resume.
- Phone Settings pages stay painted while closing.
- Each worker gets its own temp folder, and its leftovers stop when the pane closes.
- The cleanup sweep no longer freezes the app.

## [1.0.243] - 2026-11-08

### Added
- Live Verify checks sites built by bots and shows results with Rerun and Watch.
- Inkwell, Graphite and Moss dark themes, with all existing themes kept.
- Agentic Mode appears first in Bot Details.

### Changed
- Bots check past builds and decisions before planning.
- The bot guide matches the app.

### Fixed
- Type immediately after picking a model.
- Swipe right to close Bot Details on phones.
- Copy and save images from another PC's chat.
- Reaction chips stay clear of reply text.
- Servo bot bubbles no longer show a side line.
- Finished workers no longer show a false stalled notice.
- Gemini and Grok usage records include cached input.
- Muse refresh gets a fresh reading and says when to sign in again.
- Sync picks up files it previously skipped.

## [1.0.242] - 2026-11-08

### Added
- An activity grid per account in Usage.
- Drag accounts to reorder them in Connections. Usage follows the same order.
- Tap the usage bar to open the small limits card.
- Ctrl+number switches bots, Alt+number opens that worker's terminal, and Ctrl+` opens Main.

### Changed
- Ctrl+plus/minus zooms in smaller steps.
- The quick usage card follows your Usage order.

### Fixed
- Wink no longer lags at startup on PCs with many old worker folders.
- A message you send while a bot is answering another bot gets its own reply.
- Single-account Connections rows show the signed-in email.

## [1.0.241] - 2026-11-07

### Fixed
- Startup lag on PCs with many old worker folders, first pass.

## [1.0.240] - 2026-11-07

### Added
- Watch website done-checks live or replay their desktop and phone checks.
- Pick a worker's account by name without changing Main.

### Changed
- Usage has clearer spacing and bars, a busy refresh indicator, and account-switch feedback.

### Fixed
- Signing out of Grok, Muse, Claude or Codex in Connections works on the first click.
- Usage numbers refresh correctly after switching accounts.
- Clicking empty space in the chat box focuses your draft.
- Memory and Description text stays reachable after fonts load.

## [1.0.239] - 2026-11-06

### Added
- Give a PC its own app name and logo with a brand file in the Wink data folder.

### Fixed
- A failed chat on a signed-out account names the account and offers Sign In Again.
- Sign in directly from a Usage row.
- A refused sign-in explains why.
- Space plays and pauses a chat video after dragging its seek bar.

## [1.0.238] - 2026-11-06

### Added
- Archive a bot from its menu.

### Fixed
- Keep your place when loading earlier messages.
- The Usage account button now says Switch.
- Korean shows 전환 중 while switching accounts.
- A failed worker shows as working again once it moves on.
- Text sent to a remote device's terminal arrives whole.

## [1.0.237] - 2026-11-06

### Added
- Zoom the desktop model chart with the mouse wheel.
- Pin groups to the top of the sidebar.
- Usage page redone: compact rows, slanted bars back above the chat box, drag to reorder, and expand all.
- Claude API errors that end a turn now show in chat.

### Fixed
- Show earlier messages now loads a full screen on each click.
- Fixed several layout snags on the phone.
- Korean words stay whole on phones.
- Worker notes wait while a bot answers a bot, and read "No reply from @bot" when it does not.
- Bot tools are no longer blocked after a Main account switch.
- Added Claude accounts share your user setup, including new skills.
- STALLED notes hold through Claude monitor waits.
- Update launch logs are kept past 1 MB.

## [1.0.236] - 2026-11-05

### Fixed
- Model Index charts in full screen on the phone keep their tabs on top, swipe to the next chart, and zoom with a pinch or a double-tap.
- Settings > Devices no longer flickers its check marks when it opens.
- The @ list and search show each bot's own picture.
- New group lists each AI once, even with several accounts signed in, and signing in from that list uses your Main account.
- A renamed account keeps its name after sign-in refreshes and restarts.

## [1.0.235] - 2026-11-05

### Changed
- Settings > Usage shows each account as its own row with 5h and 7d meters, % left and the reset time. Each AI shows 3 accounts with Show more for the rest, and your Main account always stays in view.
- Usage sections fold and stay folded on this device, numbers older than 5 minutes show how old they are, and the page refreshes on its own without a Refresh All button.
- The usage quick view in chat uses the same rows on desktop and phone, and closes when another window opens over it.
- Connections has a smoother menu on the phone, and an account still signing in shows one menu, clear of Cancel.

### Fixed
- The red sign-in warning clears once sign-in finishes.

## [1.0.234] - 2026-11-05

### Added
- Bots can upload files, like a voice memo for speech-to-text or an image to edit, when they call an outside service with your saved key.
- Bot Details shows a green Saved mark beside Description each time your edit saves.

### Changed
- Bots can go 24 turns with each other for each message you send, up from about 3. When they reach it, the chat says so and how to reset it.
- Grok and Muse keep their sessions ready between turns, so their next reply can start sooner.

### Fixed
- Pictures and videos a bot links in chat now open on your other PCs and your phone, even when saved outside the bot's folder.
- Gemini workers no longer stop at the "trust this folder" question.
- Clicking beside a long Description no longer jumps to the bottom of the text.
- The reply timer keeps counting from your first message when you add more while a bot is replying.
- Restarting Windows is no longer reported as Wink closing unexpectedly.
- Worker panes keep their private message keys off the screen and out of notes.

## [1.0.233] - 2026-11-05

### Changed
- Bots know which account each of their workers runs on, shown as a number (Claude 1, Claude 2) or your nickname.
- After you change an engine's Main account, bots with workers on that engine get one short note naming the workers still on the old account.

### Fixed
- Workers on a newly signed-in Claude account no longer stop at Claude's first-run screens.
- A Claude worker waiting on a long background command no longer gets a stall alert every 30 minutes; the first comes after 2 hours.

## [1.0.231] - 2026-11-05

### Added
- Closing a terminal pane while its worker is running asks first.

### Changed
- Wink shows your chat sooner after it starts.
- The phone opens your chat without waiting on the live connection; a first open says Updating, and Reconnecting shows only after a real drop.
- Bot Details groups its settings in boxes on one edge, with one text size scale and one scroll.
- Folds, panels and menus open and close smoothly with the same timing, and their arrows point where the panel goes.
- Team reports in your chat are titled Bug Report.

### Fixed
- Ctrl+` opens the terminal on Main until you pick a pane.
- Bots answering another bot keep their safe tools, so replies between bots go through.
- The terminal header stays steady, and its buttons share one hover style.
- Error reports no longer count an update install as a crash.

## [1.0.230] - 2026-11-04

### Added
- Usage has an account menu beside each engine icon, so you can jump straight to any account. The bars slide to the one you pick.
- Videos in another PC's window can play full screen.

### Fixed
- The PCs menu no longer shows an off PC as online: each PC says Checking, then Online or Offline within about 2 seconds.
- Opening another PC shows a Connecting screen instead of a black window.
- The Update button shows in the desktop bot list again when an update is ready.
- Pressing Enter in the model picker's List View picks the model and stays in List View.
- Running the tests can no longer touch your real Wink data.

## [1.0.229] - 2026-11-04

### Added
- Workers come back after Wink restarts or updates, on the same conversation.
- Bot Details has a Memory tab, so a bot's memory sits in its own place instead of one long page.
- File links from another PC open in Wink: pictures and videos play inline, web pages open in a Wink window, other files download.
- Usage refreshes old readings on its own when you open it, and shows how old a reading is until the new one lands.

### Changed
- Account screens are cleaner: one icon per account, Add Account and Set as Main on the engine row, and accounts with only a weekly limit line up with the rest.
- Usage shows your Main account in full color and the others faded. On the phone it shows one account at a time, Main first.
- Usage sits right under Connections in Settings.
- Workers use the engine's Main account, even when a bot on another engine starts them. If Main is signed out, they use your default account and say so.
- The terminal has no tab strip: switch panes from the worker list, which now lives in the terminal header.
- Code sign-in reads "Sign in with your browser", with a "Paste the code here" box.
- Terminal themes show each work step on one line, with output folded and a click to see more.
- The name box and Language row in Settings match the other rows' widths.

### Fixed
- Gemini bots no longer drop a reply after a long command, and their messages to other bots go through.
- Opening a memory file keeps its header on screen.
- Rooms set to Lead before an update now answer like new rooms.
- Model Index tabs fit on the phone.
- New Claude workers no longer stop on the Bypass Permissions screen.

## [1.0.228] - 2026-11-04

### Added
- Wink clears worker scratch folders after panes close, removes old unused worktrees, and limits diagnostic log growth.

### Changed
- One privacy switch turns off both crash reports and usage stats.
- Sign Out on your Main account picks another ready account without a trip to Usage.

### Fixed
- The usage bar above the chat follows your Main account.
- Workers keep your default Claude and Codex settings, and Claude no longer stops on setup screens.
- Script panes can start through shell wrappers again.
- Add Account waits for a signed-in account, and engine rows no longer flash Sign In while Wink checks the login.
- Sign-in controls recover after failed or canceled attempts.
- Bots keep their delegation task ids after a fresh session.

## [1.0.227] - 2026-11-03

### Added
- More than one Claude or Codex account: add accounts in Settings > Connections, compare usage, and pick the Main account on the Usage page.
- Model Index fills gaps with older dated scores (hover shows the date); Legal covers more models, and Design now has Score vs Cost.
- Updates show a progress window while Wink restarts.

### Changed
- Simpler first run and rooms: installed engines come first, new rooms default to every bot answering, and @ picks one bot.
- Settings is lighter for new users: one visible privacy switch, smaller rows, and Terminal Colors and Terminal Alerts hidden.
- Chat errors use plain words in calm gray rows with a small warning mark; details fold below.
- The worker chip labels its count on wide headers and shows a bot icon and status dot.

### Fixed
- Sending during a running turn joins it where supported; queued messages wait instead of showing a busy error.
- Pasted blocks and attachments survive message edits; choice-only messages no longer show an empty bubble.
- Korean text for replies, search, connectors and Auto warnings.
- Saved keys survive credential migration, and other-PC windows recover from expired sign-ins and stalled loads.
- Local VM cleanup only stops or removes containers created by Wink.
- Chat sync keeps catching up until ready, and stale approval cards clear in rooms after a restart.
- Claude worker panes keep their busy or idle state without confusing Muse panes, and Grok worker instructions list effort choices.
- Room previews show questions and worker notes correctly, and notification clicks open their target once.
- Access tokens split across streamed output stay masked.
- Engine discovery refreshes after the login shell loads, and project imports create their room.
- Connected Apps keeps its last known connections when refresh fails and offers Retry when none can be checked.
- Send to terminal works when Share Terminal with Chat is off; approval requests block sends and attachments.
- File links with line numbers or query text open the right file.
- Phone bot menus and section pickers stay on screen with the bot list on the right.
- Room chats show saved-summary dividers in terminal skins, and Space in call controls no longer interrupts speech.
- Team Today shows unavailable totals as unknown and refreshes at midnight in Korea.

## [1.0.226] - 2026-11-03

### Added
- Settings > Devices: guided Tailscale setup for phones and PCs, with store QR codes, Sign In, and Connect a Device in the Your PCs menu.
- Servo Gray theme. Themes shows 8 featured skins up front, with the rest under More Themes.
- An infinity mark for Agentic Mode.
- Summaries for Grok and Muse bots.
- First run offers a GitHub star and asks before sending anonymous usage stats.
- New team bug reports wake the lead bot right away.

### Changed
- Pewter, Blueprint Gray and Charcoal use a softer, lighter font and selection.
- Messages start faster: turn snapshots, the built-in browser, the computer panel and other hidden screens are gone (about 20,000 lines).
- Bots reply in the language you write in.

### Fixed
- Bot-to-bot replies are never lost, survive a restart, and wake an idle bot that handed off the job.
- Today counts are right across PCs and after midnight.
- The phone usage meter is back.
- Worker panes send notes again after a worker resumes past its report.
- First run no longer says "You're all set" before an engine is ready; narrow windows show the phone QR code; Devices checks Tailscale far less often and still finds new devices.
- A Codex steer note shows only after an answer is on screen.

## [1.0.225] - 2026-11-02

### Added
- Memory view in Bot Details: what the bot learned from your chats and its current task come first, with the raw memory file folded below.
- A "Sign in" card above the message box when a bot's engine is signed out, shown before you type.

### Changed
- The model chip has a light bevel.
- New groups are one short card, with the reply rule spelled out.
- Find leaves the chat header (Ctrl+F still opens it), and Start Fresh moves under Advanced.
- Removed Team Map and section notes.

### Fixed
- The model dial selects on the first tap after a swipe, and Max gives a double buzz.
- A signed-out Claude bot says so instead of showing nothing.
- Teammate bug reports reach the owner's lead bot when it sits in a named section.
- A Codex usage limit sends one note, even with a background terminal open.

## [1.0.224] - 2026-11-02

### Fixed
- Codex keeps its short reply to a message you send mid-answer, so both the earlier task and the new one get answered.

## [1.0.223] - 2026-11-02

### Changed
- The model dial stays in its desktop layout down to 800 px wide, keeps text readable, and fits short windows.
- The model dial turns one model per swipe, drag or wheel flick, at any speed.
- Chats open about a second faster on a cold start.
- Bots keep track of unfinished work across chat summaries and before calling a task done.

### Fixed
- The model dial title no longer hides under the window caption.
- Sending a message clears a stuck "Paused" Agentic Mode.

## [1.0.222] - 2026-11-01

### Added
- Full-screen image viewer.
- Swipe back through phone Settings.
- Phone settings show which phones are connected.
- A "catching up" line above the composer while sync catches up.

### Changed
- Cleaner chat and menus: shorter bot menu, no pin button under messages, no pencil beside the bot name.
- Pinned bots sit above a foldable Others section.
- Worker icons are back in the chat header.
- The phone app opens from a saved shell when the connection is slow.
- Claude usage stays quiet when rate limited.

### Fixed
- Servo's composer strip lines up with the frame, and the model picker keeps its own colors in Servo.
- The relay setup form scrolls fully into view.
- The phone terminal status line fits.
- Reachable PCs stay online while sync catches up.

## [1.0.221] - 2026-11-01

### Changed
- Team bug reports send only on one fixed call phrase.
- The model dial confirms your pick with a press, a ring and a short buzz on phones.

### Fixed
- Codex no longer repeats its answer when you add an instruction mid-answer.

## [1.0.220] - 2026-11-01

### Added
- Team members can send a Wink bug report from chat; the bot gathers the chat and screenshots.
- The model dial is on for team members.

### Changed
- Codex chats answer once: "working on it" lines hide when the answer lands.
- Codex gets Wink's instructions once instead of with every message.
- Long Codex chats get summaries, like Claude chats.
- Chats open faster on the PC again.

### Fixed
- Interrupted syncs between PCs keep their chat branches separate.

## [1.0.219] - 2026-11-01

### Added
- Servo, a monochrome theme.
- Stuck workers on a teammate's PC are reported to the team owner automatically.

### Changed
- The phone chat opens faster.

## [1.0.218] - 2026-10-31

### Fixed
- An idle worker gets nudged again at 30 and 60 minutes instead of only once.
- A bot that gets asked a question in a delegated reply is woken to answer it.
- Workers delete their own scratch folders when they finish.
- "Worker finished" notes come only from commands a bot started.

## [1.0.217] - 2026-10-31

### Added
- Unread chats show a count on the bot's avatar. Mark as Unread shows 1.

## [1.0.216] - 2026-10-30

### Added
- Swipe down to close sheets on the phone.
- The bot's subtitle shows "3 workers" while its workers run, and the model again when they finish.
- Settings > Phone pairs a phone with a QR code.
- One-button engine setup that notices when the install finishes.
- Phone Settings is a labeled list.

### Changed
- Wink opens in Korean on Korean Windows unless you picked a language.
- Agentic mode keeps working until an engine is fully out of its limit.
- "Engine" is used everywhere for Claude, Codex, Grok, Gemini and Muse.
- First run is simpler: clearer New Bot path, a suggested bot name, and Usage lists only installed engines.

## [1.0.215] - 2026-10-30

### Fixed
- Settings > Usage shows each Codex limit once.
- Claude and Grok limits refresh again in Settings > Usage.
- The usage refresh error reads as two sentences, in Korean on a Korean screen.
- Long chats keep the names, codes and numbers you gave the bot after a summary.
- The remove X on an attached file shows in full.

## [1.0.214] - 2026-10-29

### Added
- A chat that hits a Claude or Codex usage limit resumes on its own when the limit resets; sending any message cancels it.
- 13 more avatar choices: 8 job symbols and 5 engine colors.
- Optional error reports, off until you turn them on.

### Changed
- A usage limit shows "Usage limit reached" with its reset time.
- Each bot shows the avatar color you picked everywhere, and a calm gray icon is one of the choices.
- Confirmations like delete open inside Wink instead of a Windows dialog.
- Wink shows no Windows pop-ups while it is the window in front.

### Fixed
- Keys saved from your phone or another PC are stored on the bot's own PC.
- Codex "model at capacity" stalls continue on their own and never type over a message you are writing.
- While Codex thinks silently, the chat shows Thinking instead of the no-reply hint.

## [1.0.213] - 2026-10-28

### Changed
- Bot lists show Wink icons in a calm style; the open chat's header keeps the icon in full color. Uploaded photos and older icons look the same.
- The avatar picker offers only the Wink icons, plus your own image.
- Default-font themes use Geist for English text; Korean text keeps its current fonts.

## [1.0.212] - 2026-10-27

### Added
- Install in Settings > Connections and onboarding runs the engine's install in a terminal with one tap, and installs Node first when the engine needs it.

### Changed
- GPT-6.1 Terra replaces GPT-5.6 Terra in the Codex picker, and saved picks move over.
- Bots know their plain text shows in chat, so fewer notes to self reach the chat.

### Fixed
- The no-reply hint waits for real engine silence: while Claude thinks, the chat shows Thinking instead of the hint.
- On phones, Back closes Select text, and holding a word shows the phone's own drag handles.
- Back closes pop-ups in the order they opened.

## [1.0.211] - 2026-10-27

### Changed
- Terminal skins leave a blank row before a reply that follows tool rows, so replies are easier to spot.

### Fixed
- Phone Back closes the worker list, and other open pop-ups, before it leaves the chat.
- Opening an offline PC from the device list shows the unreachable page instead of hanging, and PCs no longer stay Offline when Tailscale starts after Wink.
- Phones no longer get a 502 error on a connection that sat idle for 90 seconds.
- Install in Settings > Connections opens the install terminal with the engine's command, as onboarding does, instead of the engine's website.
- Pasting right after a screenshot attaches the image instead of an empty file, and a paste that still fails says so.
- File links to Windows paths with a backslash before a dot or other punctuation, like `\.orbit`, open on desktop and phone.
- Switching models from the no-reply hint no longer reruns the last message while a follow-up is still posting.
- While Codex reconnects, a worker note or a new message no longer drops the chat out of Reconnecting.
- While a worker waits on a limit or stall, phones stop downloading its whole terminal screen every 15 seconds.
- The Thinking shimmer hides while Wink is unfocused or hidden, instead of freezing mid-word.
- On the usage page, an engine's name opens the same account card as its icon.

## [1.0.210] - 2026-10-26

### Fixed
- Workers start again on PCs with little free memory, like 8 GB laptops: the 2 GB reserve from 1.0.209 is gone, so a terminal opens whenever free memory covers its engine, as in 1.0.208.

## [1.0.209] - 2026-10-26

### Added
- Worker launches show the engine's 5-hour and weekly usage left, and a launch on a nearly empty window is held once.
- Bots see the names of your saved API keys, never the keys, so they use them instead of asking for a new one.

### Changed
- The fixed 32-terminal limit is gone: bot terminals open while the PC keeps 2 GB free, and a refusal names the bots holding terminals.
- After Wink refreshes a bot's session, the bot skips rereading big files unless the task needs them.

### Fixed
- A worker row goes back to Working once its terminal moves again, and waits on a background agent or a usage-limit pause no longer send stall notes.
- A worker's row sits at its newest message on every device, and loading older messages never moves it.
- On phones, the scrollbar no longer covers worker status words.
- A silent tool no longer holds a bot's chat for 30 minutes; bots give up after 5.
- A dropped Codex connection shows a quiet "Reconnecting" line instead of a red error per retry.

## [1.0.208] - 2026-10-26

### Added
- A message sent to a chat that is still syncing from another PC waits for it, up to 10 seconds ("Sends after sync"), so the bot replies with the whole chat in view.

### Changed
- After a restart, the chat you had open syncs first.

### Fixed
- A chat that split between two PCs shows its notice.

## [1.0.207] - 2026-10-25

### Added
- When a model hasn't replied for 2 minutes, Switch on its hint reruns your last message on the model you pick.

## [1.0.206] - 2026-10-25

### Added
- Bots can open a short guide to Wink when a task is about Wink itself.

### Changed
- Bots use an engine you're signed in to before asking for an API key.

### Fixed
- A bot no longer stays busy after two failed starts in a row, such as a moved project folder or a missing CLI.
- A group keeps answering after a failed start.

## [1.0.205] - 2026-10-25

### Changed
- After your PC starts or wakes, chats sync before pictures.

### Fixed
- A message sent while your PC was still catching up joins the chat instead of being hidden, and the bot is told what it missed.

## [1.0.204] - 2026-10-24

### Added
- The timeline marks messages that carry an image or a file.

## [1.0.203] - 2026-10-24

### Added
- When an engine hasn't replied for 2 minutes, the waiting line names it and counts the minutes.
- Changing a Claude bot's effort mid-turn applies at its next step, in the same session.
- When a bot's project folder is missing, Choose folder picks a new one in place of Retry.

### Changed
- The chat header drops its busy spinner, and step spinners hide while Wink is out of focus.

### Removed
- Untested engine drivers. Wink runs Claude Code, Codex, Gemini, Grok and Muse.

### Fixed
- Chats synced from your other PCs show new messages within seconds instead of up to 30 s.
- New Claude Code workers no longer get stuck on the folder trust prompt.

## [1.0.202] - 2026-10-24

### Added
- Alt+W opens and closes the worker list.

### Fixed
- A Claude worker's save line now submits near its context limit, with no false context note.

## [1.0.201] - 2026-10-23

### Fixed
- Pinning or unpinning a message on one PC now shows on your other PCs.

## [1.0.200] - 2026-10-23

### Changed
- Worker cards ask for the smallest diff in the repo's own voice, with new logic kept out of large files.

### Fixed
- Opening Wink on your phone renews its remote login, so uploads no longer fail as unauthorized after 30 days.
- A Windows update cut off by a restart finishes at the next sign-in instead of leaving Wink uninstalled.
- No false context note while a Claude worker compacts or its save line waits in the input.

## [1.0.199] - 2026-10-23

### Changed
- The terminal header no longer has a Restart button; restart from the footer when the shell exits, or from the project-changed banner.

### Fixed
- Wrapped keyboard shortcut keys stay right-aligned on narrow screens.
- A bot channel only gets the reply meant for that bot, not a status update for you.
- Gemini Argon and Flash workers show the Gemini icon.
- Deleting a bot removes the event logs of all its tasks.
- Moving a pinned bot down lands it one row down, not two.
- On phone, the first quick tap on a thread's turn rail opens it.
- Adding a bot while creating a group keeps the current chat in view.
- Escape closes step 2 of the group wizard without a click first.
- The webhook "..." menu closes after Edit settings, and editing a webhook whose bot was deleted picks a live bot.

## [1.0.198] - 2026-10-22

### Added
- The working indicator shows elapsed time for the whole turn, like "(1m 19s)".

### Changed
- One Stop ends the turn and puts any queued messages back in the message box, on every device.
- While Wink isn't focused, the working ring hides and the timer keeps ticking, which saves CPU.
- Bots save a lesson from each correction without being asked.

### Fixed
- "Continue" after a stopped turn picks up the request that never finished, not an older task.
- A busy Gemini turn retries even after it already wrote a progress note.
- Tooltips on the bot list header no longer hide under the Windows title bar.

## [1.0.197] - 2026-10-21

### Changed
- Settings > Connections shows one Sign In or Sign Out per engine, with no path settings.

### Fixed
- Muse tool steps show in chat while a turn runs, when Show tool calls is on.
- Grok sessions restart only when they're actually large, not after a fixed number of tool steps, so long Grok chats stop repeating themselves.

## [1.0.196] - 2026-10-21

### Added
- One-click sign-in for Claude, Codex, Grok and Muse in Settings > Connections. Gemini opens a terminal and detects sign-in.
- Hovering an engine in Settings shows the account it's signed in with.
- Use Google Photo in Account settings switches back to your Google picture.

### Changed
- Bots split several tasks at once into parallel visible workers.
- A worker's notes go to the bot that started it.

### Fixed
- Workers no longer stop at Claude, Codex or Grok folder trust questions.
- Worker icons show for model names written without a space, like "Opus5.5".
- Phone Link shows the link to turn on Tailscale Serve and connects once it's on, with no restart.
- Gemini retries by itself when its servers are busy, and long Gemini turns run up to 60 minutes.

## [1.0.195] - 2026-10-21

### Added
- The model picker shows the list price per 1M input and output tokens for current models.
- Change Photo and Remove Photo in Edit Profile. A new install fills your name and photo from Google sign-in, and a removed photo stays removed.
- Agentic Mode can wait for a set start time before it runs the next step.

### Changed
- Keep going is now Agentic Mode. Turning it on approves the whole task, including steps a bot adds or rewords later.
- Labels use Title Case.
- Rules your Chief of Staff bot passes on count as your own for other bots.
- Bots react to messages a little more often.
- Workers run at high effort by default, and at max only in max mode.

### Fixed
- A worker pane that exits early now tells its bot, and a pane whose shell fails to load on Windows retries once.
- Fewer repeated context notes, and no early stall notes for workers still waiting to start.
- Worker effort shows for labels with a trailing note, like "high API".

## [1.0.194] - 2026-10-20

### Added
- Keep going: a per-bot switch that starts the next approved plan step every 30 minutes while the bot is idle. A small mark on the avatar and chat header shows when it is on, and telling a bot "keep going" turns it on.
- A bot gets a short note to move details into side files when its memory nears the size limit.

### Changed
- Workers get their context note at about 80% of the window, and Wink types the save-progress line into the worker itself.
- Messages from other bots show on the left under a "Message from" label.
- Shorter text in bot settings.

### Fixed
- Claude Code menus in worker panes redrawing in the wrong place.
- Worker panes dropping the user's own status line on some PCs.

## [1.0.193] - 2026-10-20

### Added
- Chat box ring: a Theme colors choice next to Rainbow that shimmers in the current theme's own colors.
- Model index: Design and Security tabs, and Coding now ranks on Terminal-Bench and FrontierCode with the newest models.
- A dev update channel for testing new builds on one PC, with a one-click way back to stable from the taskbar menu.

### Changed
- Auto mode now covers routines and other turns nobody started, so they never stall on a permission card. Desktop control in those turns is skipped instead of asked.
- Settings > Shortcuts shows one row: Queue message, Ctrl+Enter or hold Send on a phone.

## [1.0.192] - 2026-10-20

### Added
- Model index: Gemini 4 Argon on the Intelligence, Agentic and General charts.
- A bot gets one note when a worker it launched passes 200k context, and its pane list shows each worker's context size.

### Changed
- The chat box is ready about 0.3 s sooner after launch.
- Worker panes run at below-normal CPU priority, so Wink stays quick while workers are busy.
- Spinners and the rainbow chat box pause while Wink is in the background. The needs-you pulse keeps running.
- A new pane needs only the memory its engine uses (600 MB for Claude, 150 MB for Codex or Muse), not 2 GB free.
- Claude workers summarize at about 300k context instead of 500k.

### Fixed
- The Legal chart in the model index not drawing.

## [1.0.191] - 2026-10-19

### Changed
- Most replies no longer wait for a chat summary to finish. The summary lands on the next turn.
- Bots skip the closing recap after tool work.

### Fixed
- Send now showing while a turn was still getting ready, when it could not act.
- Gemini replies showing a timeout error that was already retried.

## [1.0.190] - 2026-10-18

### Added
- Right-click a queued message to send it now or cancel it. On a phone, hold it. Groups offer Cancel.
- Right-click a chat image, or the full-size view, to copy or save it.
- Wink-style tooltips replace the old Windows ones across the app.
- Settings > Shortcuts lists the chat keys: Enter, Ctrl+Enter and hold Send.

### Changed
- Settings > General is down to Language, Bot list side, Reply style and Updates. The rest is under Advanced.
- Desktop pop-ups pause while the PC is idle for 5 minutes or locked. Phone alerts are unchanged.
- Reactions are down to 14, with 😮 in the right-click row.
- A bot's row lights up only when it posts something you can see.
- Empty Quorum days show a thin baseline.

### Fixed
- The phone header hiding the model name.
- Worker names cut short in the workers menu.
- The Quorum row loading late and jumping on hover.
- A waiting marker stuck in a reply's buttons.
- Right-clicking a file link opening two menus.
- False "stuck" alerts on quiet workers, and repeated usage-limit notes.
- Tooltips on long pasted text running off the screen.

## [1.0.189] - 2026-10-18

### Added
- Right-click a file link to show it in its folder, save a copy or copy its path.
- Worker rows show effort next to the model, like `Muse 1.3 · Max`.

### Changed
- In long chats, the timeline rail is the scrollbar.
- The timeline card opens when the mouse rests on the rail, not in passing.
- Several memory saves in a row fold into one "Memory updated · N notes" row.
- A follow-up sent while a Claude reply is still thinking joins it, so you get one answer.
- Replies to worker notes no longer send a finished alert.
- 👌 replaces 🫡 in reactions, since Windows 10 draws 🫡 as a box.

### Fixed
- A reply's last characters showing up later as a stray bubble.
- Gemini replies repeating a rate-limit error that was already retried.
- Blank Gemini and Qwen icons in narrow windows and on phones.
- Long-chat summaries failing instead of trimming to fit.
- A teammate's answer lost when your message joined its turn.
- A teammate's "Reply to @X" label dropped when another message landed first.
- A stalled Claude restart delivering its reply on the next turn.
- Over-limit task records rejected, or clipped inside a file path.
- Timeline, swipe and question card polish.

[1.0.251]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.251
[1.0.250]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.250
[1.0.249]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.249
[1.0.248]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.248
[1.0.247]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.247
[1.0.246]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.246
[1.0.245]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.245
[1.0.244]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.244
[1.0.243]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.243
[1.0.242]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.242
[1.0.241]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.241
[1.0.240]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.240
[1.0.239]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.239
[1.0.238]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.238
[1.0.237]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.237
[1.0.236]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.236
[1.0.235]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.235
[1.0.234]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.234
[1.0.233]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.233
[1.0.231]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.231
[1.0.230]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.230
[1.0.229]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.229
[1.0.228]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.228
[1.0.227]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.227
[1.0.226]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.226
[1.0.225]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.225
[1.0.224]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.224
[1.0.223]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.223
[1.0.222]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.222
[1.0.221]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.221
[1.0.220]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.220
[1.0.219]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.219
[1.0.218]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.218
[1.0.217]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.217
[1.0.216]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.216
[1.0.215]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.215
[1.0.214]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.214
[1.0.213]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.213
[1.0.212]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.212
[1.0.211]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.211
[1.0.210]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.210
[1.0.209]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.209
[1.0.208]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.208
[1.0.207]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.207
[1.0.206]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.206
[1.0.205]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.205
[1.0.204]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.204
[1.0.203]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.203
[1.0.202]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.202
[1.0.201]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.201
[1.0.200]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.200
[1.0.199]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.199
[1.0.198]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.198
[1.0.197]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.197
[1.0.196]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.196
[1.0.195]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.195
[1.0.194]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.194
[1.0.193]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.193
[1.0.192]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.192
[1.0.191]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.191
[1.0.190]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.190
[1.0.189]: https://github.com/aiedwardyi/orbit-releases/releases/tag/v1.0.189
