# Restart button

A DeepSeek Harness Desktop plugin that puts a **Restart** row at the bottom of the sidebar, right above Settings.

Press it once and the row turns into an in-place confirm: `Restart` and `Cancel`. Escape, `Cancel`, or a second press on the row returns it to idle. That two-step confirm is the whole anti-mistake design — no long press, no counting clicks, no separate dialog.

## Why there is a supervisor

The desktop app is an Electron shell around a Host process, and neither one can restart the shell on request:

- A plugin runs inside the Host and cannot reach `app.relaunch()`; that call lives only in the shell's development menu and its crash-recovery dialog.
- If the Host leaves while the shell still expects it, the shell treats that as a crash and shows **Application failed to start or stopped unexpectedly** — not a restart.

So the restart decision sits outside the app. `supervisor/dsh-watch.mjs` starts `DeepSeek Harness.exe`, waits for it, and starts it again when the row asks for one. Start the app through that script — a shortcut to it, or `node dsh-watch.mjs` — and the row works. Start the app the old way and the row still appears, but it answers *Start the app through dsh-watch.mjs to use this.* unless a supervisor is already watching (see below).

The supervisor can also take over an app you opened by hand: a request names whatever instance currently holds the single-instance lock, so the row works even for an app started from Explorer, as long as a supervisor process is around. What it cannot do is start the app when none is running and no supervisor exists.

A second start while the app is already open cannot obtain the single-instance lock, so it exits at once; the supervisor retries with a backoff that tops out at 30 seconds and never gives up, logging each round in `watch.log`. A request that arrives during a backoff is honoured immediately rather than after the wait.

## What it does

1. The row asks the Host session list whether any agent turn is running. If one is, the row says **A turn is running. Stop it first.** and refuses to open the confirm.
2. `Restart` posts to `/api/restart-button/request` on the shared connection channel, which only an authenticated browser session of this Host can reach.
3. The Host re-checks for running turns, then writes `~/.dsh/restart-button/restart-request.json`. It answers `409 busy` instead of writing while a turn runs, so the guard does not depend on what the page believed. It answers `409 no-supervisor` when no watcher is running.
4. The supervisor sees the file within a second, ends whichever instance currently holds the single-instance lock (not only a child it started itself), together with its children, waits for the lock to clear, and starts a fresh instance. No recovery dialog is involved, because the exit is a normal end of the process tree rather than a Host that vanished under a running shell.

## What you see

The window closes and comes back after a couple of seconds, on a new port, with no dialog in between.

Two shortcuts that look like a restart are not one: closing the window hides the app to the tray, and quitting from the tray exits without restarting.

## Install

```sh
dsh plugin add <path-to-this-directory>
```

Then start DSH once more; the row appears in the sidebar foot.

For the row to actually restart anything, a supervisor must be running. The simplest way is to launch the app through it: double-click `start-dsh.bat`, which points at the app's own bundled Node runtime, or run it yourself:

```sh
node supervisor/dsh-watch.mjs [--exe "C:\path\to\DeepSeek Harness.exe"]
```

Keep that launcher's console window open: closing it stops the supervisor, and the row goes back to *Start the app through dsh-watch.mjs to use this.*

### Running it with no window at all

A console window is the one drawback of the launcher above, and closing it by accident looks exactly like "the button stopped working". A Scheduled Task avoids that:

1. `run-hidden.vbs` (ship it next to the supervisor) starts a command with `WScript.Shell.Run(..., 0, False)`, which creates **no console window at all**.
2. Register the task to run `wscript.exe` with `run-hidden.vbs <node.exe> <path-to-dsh-watch.mjs>`.

`schtasks /TR` is capped at 261 characters, which those paths exceed, so register through PowerShell:

```powershell
$svc = New-Object -ComObject Schedule.Service; $svc.Connect()
$def = $svc.NewTask(0)
$def.Settings.Hidden = $true
$def.Settings.ExecutionTimeLimit = 'PT0S'
$def.Principal.LogonType = 3          # interactive token: the app stays visible
$def.Principal.RunLevel  = 1
$a = $def.Actions.Create(0)
$a.Path      = 'C:\Windows\System32\wscript.exe'
$a.Arguments = '"<dir>\run-hidden.vbs" "<dir-to-node.exe>" "<dir>\supervisor\dsh-watch.mjs"'
$svc.GetFolder('\').RegisterTaskDefinition('dsh-watch', $def, 6, $null, $null, 3) | Out-Null
Start-ScheduledTask -TaskName 'dsh-watch'
```

Do **not** set the principal to a service account (`LogonType` 5) to hide the window: the supervisor would then spawn the app in session 0, where you cannot see it. `wscript` is the way to get both — no window for the supervisor, a normal visible app.

## How it is built

- `index.js` — Host half. Registers the exact Fetch route, checks for running sessions, writes the request file. It never stops the Host.
- `client.js` — Client half. The sidebar-foot row, its in-place confirm, the work guard over the Host session list, and its own CSS. The refresh glyph is inlined: the Harness UI packages are bundled into the web frontend rather than exposed to plugin bundles.
- `supervisor/dsh-watch.mjs` — the outside watcher: starts the app, polls for the request file, restarts on request.
- `locale/en.json`, `locale/zh.json` — title, description, and this page.
- `cordis.patch.yml` — inserts the `restart-button` row.

State lives in `~/.dsh/restart-button/`: `watch.pid` (written by the supervisor, removed when it exits), `restart-request.json` (written by the Host, consumed by the supervisor), `restart.log`, `watch.log`. The Host checks that the pid in `watch.pid` is still alive before accepting a restart, so a supervisor that was killed does not leave the row accepting requests nobody will act on.

## Limits

- Desktop only, and only while the app was started through `supervisor/dsh-watch.mjs`.
- A restart kills in-flight turns, which is why the guard exists.
- The supervisor ends the app with `taskkill /T`, so anything else started under the app process tree ends with it.
- Quitting from the tray still exits without restarting; the row restarts, it does not replace quitting.
