# Late worker reports

`orbit-msg.ps1` owns sending for the PowerShell, cmd and sh entry points. One invocation keeps one message ID through its retries. It retries transient failures for 45 seconds, then atomically queues a local report in the profile's `mailbox-outbox` folder. Authentication and validation errors remain failures. Remote panes retry through their existing reverse tunnel without a local queue.

`deliverMailboxOutbox(profile, mailboxUrl, runs?)` runs delivery in a worker thread after the server is ready. Calls for the same profile share an in-flight delivery; an empty outbox does nothing. With the existing pane ledger, acknowledged final reports retire only their matching prior pane before the worker removes the queue record. Read or retirement-write failures retain the record. The queue keeps the newest 500 reports for at most seven days.

Each drain has one ten-second HTTP budget. Unfinished report panes stay out of startup recovery; unreadable records hold all prior panes until their identity can be checked. One follow-up drain after recovery picks up reports written beyond the first snapshot. Entries still unfinished remain queued for the next startup, along with their held recovery records.

The sender and Windows drain worker hold an OS sharing lock on one fixed file, so a crashed sender leaves no stale ownership. The worker uses [libuv's Windows exclusive-sharing flag](https://github.com/libuv/libuv/blob/v1.51.0/include/uv/win.h#L636), which Node does not expose as a public constant.

The server stores a scoped receipt key on the note itself. Its bounded receipt set is rebuilt from stored notes at boot. Concurrent retries share the pending acceptance, so notification and worker-attention side effects run once. Deferred auto notes retain their original identity through watcher delivery; a final note replaces the deferred receipt. Internal receipt metadata stays out of client messages. Previous-release clients that post only text remain accepted.

The terminal bridge identity persists in the profile. `terminal-discovery.json` contains current loopback URLs without credentials. Rewritten scripts embed its profile path as Base64 ASCII for Windows PowerShell's ANSI reader, so panes using the previous release's environment can find a new port after their original URL fails. A loopback 401 checks a different published mailbox URL before stopping. Session launches save only a credential hash in the pane ledger; a fresh host verifies the old hook against that hash and the saved launch before accepting capture.

Queued note suffixes:

- English: `(sent {time} while Wink was closed)`
- Korean: `(Wink가 닫혀 있을 때 {time}에 보냄)`

No prompt or per-turn instruction changes. A queued report uses the existing single note.

## Timing gate

Gate ready, not run. Run outside any restricted timing window.

```powershell
node scripts/bench-late-reports.mjs --old=9261ef5f7 --new=HEAD --scratch="$env:ORBIT_SCRATCH"
```

The script archives both commits into throwaway folders, uses isolated homes and profiles, and starts both servers hidden with a nonexistent engine driver. It warms each endpoint, alternates the order of 30 paired mailbox POSTs, records every sample and compares p95 with a 5% limit. It does not time app startup. The app's delivery and discovery work begin after the first window.
