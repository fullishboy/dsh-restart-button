# Restart button

A DeepSeek Harness Desktop plugin that puts a **Restart** row at the bottom of the sidebar, right above Settings.

Press it once and the row turns into an in-place confirm: `Restart` and `Cancel`. Escape, `Cancel`, or a second press on the row returns it to idle. That two-step confirm is the whole anti-mistake design — no long press, no counting clicks, no separate dialog.

## Why there is a supervisor

The desktop app is an Electron shell around a Host process, and neither one can restart the shell on request:

- A plugin runs inside the Host and cannot reach `app.relaunch()`; that call lives only in the shell's development menu and its crash-recovery dialog.
- If the Host leaves while the shell still expects it, the shell treats that as a crash and shows **Application failed to start or stopped unexpectedly** — not a restart.

So the restart decision sits outside the app. `supervisor/dsh-watch.mjs` starts `DeepSeek Harness.exe`, waits for it, and starts it again when the row asks for one. Start the app through that script — a shortcut to it, or `node dsh-watch.mjs` — and the row works. Start the app the old way and the row still appears, but it answers *Start the app through dsh-watch.mjs to use this.*

## What it does

1. The row asks the Host session list whether any agent turn is running. If one is, the row says **A turn is running. Stop it first.** and refuses to open the confirm.
2. `Restart` posts to `/api/restart-button/request` on the shared connection channel, which only an authenticated browser session of this Host can reach.
3. The Host re-checks for running turns, then writes `~/.dsh/restart-button/restart-request.json`. It answers `409 busy` instead of writing while a turn runs, so the guard does not depend on what the page believed. It answers `409 no-supervisor` when no watcher is running.
4. The supervisor sees the file within a second, ends the app it started together with its children, waits for the single-instance lock to clear, and starts a fresh instance. No recovery dialog is involved, because the exit is a normal end of the process tree rather than a Host that vanished under a running shell.

## What you see

The window closes and comes back after a couple of seconds, on a new port, with no dialog in between.

Two shortcuts that look like a restart are not one: closing the window hides the app to the tray, and quitting from the tray exits without restarting.

## Install

```sh
dsh plugin add <path-to-this-directory>
```

Then start DSH once more; the row appears in the sidebar foot.

For the row to actually restart anything, launch the app through the supervisor:

```sh
node supervisor/dsh-watch.mjs [--exe "C:\path\to\DeepSeek Harness.exe"]
```

Running the supervisor by hand needs a Node executable on `PATH`. Without one, point a shortcut directly at the app's own bundled runtime:

```bat
"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" "C:\path\to\supervisor\dsh-watch.mjs"
```

## How it is built

- `index.js` — Host half. Registers the exact Fetch route, checks for running sessions, writes the request file. It never stops the Host.
- `client.js` — Client half. The sidebar-foot row, its in-place confirm, the work guard over the Host session list, and its own CSS. The refresh glyph is inlined: the Harness UI packages are bundled into the web frontend rather than exposed to plugin bundles.
- `supervisor/dsh-watch.mjs` — the outside watcher: starts the app, polls for the request file, restarts on request.
- `locale/en.json`, `locale/zh.json` — title, description, and this page.
- `cordis.patch.yml` — inserts the `restart-button` row.

State lives in `~/.dsh/restart-button/`: `watch.pid` (written by the supervisor), `restart-request.json` (written by the Host, consumed by the supervisor), `restart.log`, `watch.log`.

## Limits

- Desktop only, and only while the app was started through `supervisor/dsh-watch.mjs`.
- A restart kills in-flight turns, which is why the guard exists.
- The supervisor ends the app with `taskkill /T`, so anything else started under the app process tree ends with it.
- Quitting from the tray still exits without restarting; the row restarts, it does not replace quitting.
