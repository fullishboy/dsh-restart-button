# Restart button

Adds a **Restart** row to the bottom of the sidebar, directly above Settings.

## What it does

1. One press turns the row into an in-place confirm: **Restart now?** with `Restart` and `Cancel`.
2. `Cancel`, Escape, or a press on the row returns it to idle.
3. `Restart` posts to `/api/restart-button/request` on the shared connection channel, which only an authenticated browser session of this Host can reach.
4. The Host creates a one-shot helper outside the app's process tree; the helper ends the tree and starts the app again.

## Why the helper has to come from WMI

A plugin runs inside the Host and cannot call the shell's `app.relaunch()`. If the Host leaves while the shell still expects it, the shell reads that as a crash and shows **Application failed to start or stopped unexpectedly** — that dialog is the crash-recovery path, not a restart.

Starting a helper with `spawn(..., { detached: true })` does not solve it either. Detaching changes the session and the process group but **not the recorded parent**, so the helper is still a descendant of the app, and `taskkill /T` deletes by process tree. The helper is therefore deleted by the very kill it issued, and nothing is left to start a new instance. The symptom is a clean exit with no dialog and an app that never comes back.

`Win32_Process.Create` (through `supervisor/launch-helper.ps1`) gives a helper whose parent is `WmiPrvSE.exe`, so it is outside the tree from birth. It also inherits the caller's token, which is what lets a helper end an app that is running elevated.

`ShowWindow` must be passed as `uint16`. Passing a plain `0` makes the provider reject the whole request with a type mismatch, and without the field the helper arrives with a console window.

## The hand-over

1. The helper writes `~/.dsh/restart-button/helper.pid` to announce itself.
2. The Host polls that file until the pid is alive, and only then answers `202`. A helper that died on arrival must not be reported as a successful restart.
3. The helper waits 1.5 s so the browser receives the answer, then runs `taskkill /PID <shell> /T /F`.
4. It polls until the whole tree is gone, starts `DeepSeek Harness.exe` with its own directory as the working directory, watches it for 6 s, and exits.

The helper never stays resident, so nothing has to be started before the app and no launcher script is needed.

## The work guard

Restarting with an agent turn in flight loses that turn, so the row refuses while one runs:

- The row reads the Host session list's `running` flag and shows *A turn is running. Stop it first.* instead of the confirm.
- The Host re-checks the same fact when the request arrives and answers `409 busy` rather than starting the helper.

## What happens on screen

The window closes and returns after about a second, on a new port, with no dialog in between.

Two shortcuts that look like a restart are not one: closing the window hides the app to the tray, and quitting from the tray exits without restarting.

## Install

Install it as a local bundle:

```sh
dsh plugin add <path-to-this-directory>
```

The row appears after the next start. No supervisor or launcher has to be running for the row to work.

## Files

- `index.js` — Host half: registers the exact Fetch route, checks for running turns, creates the helper through WMI and waits for it to announce itself. It ends no process itself.
- `client.js` — Client half: the sidebar-foot row, its in-place confirm, its work guard, and its styles. The glyph is inlined; no Harness UI package is imported.
- `supervisor/launch-helper.ps1` — the `Win32_Process.Create` call.
- `supervisor/dsh-watch.mjs` — the one-shot helper: ends the tree, restarts, watches, exits.
- `locale/*.json` — title, description, and this page.
- `cordis.patch.yml` — inserts the `restart-button` row.

## The runtime it uses

The helper is started with the node bundled inside the app, derived from the app root:

```
<app root>/resources/runtime/primary-runtime/dependencies/node/bin/node.exe
```

Not `process.execPath`. The Host runs under `ELECTRON_RUN_AS_NODE` inside the app's own executable, so `process.execPath` is the app. Handing that to the launcher starts a second app instance, which dies on the single-instance lock; the button then looks like it began restarting and did nothing.
