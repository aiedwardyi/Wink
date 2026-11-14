# Late worker reports

`orbit-msg.ps1` owns sending for the PowerShell, cmd and sh entry points. One invocation keeps one message ID through its retries. It retries transient failures for 45 seconds, then atomically queues a local report in the profile's `mailbox-outbox` folder. Authentication and validation errors remain failures. Remote panes retry through their existing reverse tunnel without a local queue.

`deliverMailboxOutbox(profile, mailboxUrl)` runs delivery in a worker thread after the server is ready. Calls for the same profile share an in-flight delivery; an empty outbox does nothing. Slice C can move the startup call after adopting panes and before recovering lost workers. A file is removed only after an acknowledged POST. The queue keeps the newest 500 reports for at most seven days.

The sender and Windows drain worker hold an OS sharing lock on one fixed file, so a crashed sender leaves no stale ownership. The worker uses [libuv's Windows exclusive-sharing flag](https://github.com/libuv/libuv/blob/v1.51.0/include/uv/win.h#L636), which Node does not expose as a public constant.

The server stores a scoped receipt key on the note itself. Its bounded receipt set is rebuilt from stored notes at boot. Concurrent retries share the pending acceptance, so notification and worker-attention side effects run once. Previous-release clients that post only text remain accepted.

The terminal bridge identity persists in the profile. `terminal-discovery.json` contains current loopback URLs without credentials. Rewritten scripts embed its profile path as Base64 ASCII for Windows PowerShell's ANSI reader, so panes using the previous release's environment can find a new port after their original URL fails.

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
