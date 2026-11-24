# Restart button

Adds a **Restart** row to the bottom of the sidebar, directly above Settings.

## What it does

1. One press turns the row into an in-place confirm: **Restart now?** with `Restart` and `Cancel`.
2. `Cancel`, Escape, or a press on the row returns it to idle.
3. `Restart` posts to `/api/restart-button/request` on the shared connection channel, which only an authenticated browser session of this Host can reach.
4. The Host writes `~/.dsh/restart-button/restart-request.json`; the supervisor the app was started with ends the app and starts it again.

## Why a supervisor is needed

A plugin runs inside the Host and cannot call the shell's `app.relaunch()`. If the Host leaves while the shell still expects it, the shell reads that as a crash and shows **Application failed to start or stopped unexpectedly** — that dialog is the crash-recovery path, not a restart. The only way to restart without it is to decide outside the app, so `supervisor/dsh-watch.mjs` starts the executable, waits, and starts it again when the request file appears.

Started the ordinary way, the row still appears, but it answers *Start the app through dsh-watch.mjs to use this.* (`409 no-supervisor`).

## The work guard

Restarting with an agent turn in flight loses that turn, so the row refuses while one runs:

- The row reads the Host session list's `running` flag and shows *A turn is running. Stop it first.* instead of the confirm.
- The Host re-checks the same fact when the request arrives and answers `409 busy` rather than writing the request.

## What happens on screen

The window closes and returns after a couple of seconds, on a new port, with no dialog in between.

Two shortcuts that look like a restart are not one: closing the window hides the app to the tray, and quitting from the tray exits without restarting.

## Install

Install it as a local bundle:

```sh
dsh plugin add <path-to-this-directory>
```

The row appears after the next start.

To make the row restart anything, launch the app through the supervisor instead of the executable:

```sh
node supervisor/dsh-watch.mjs
```

The supervisor takes `--exe`, `--request`, and `--log` if the defaults do not fit.

## Files

- `index.js` — Host half: registers the exact Fetch route, checks for running turns, writes the request file. It never stops the Host.
- `client.js` — Client half: the sidebar-foot row, its in-place confirm, its work guard, and its styles. The glyph is inlined; no Harness UI package is imported.
- `supervisor/dsh-watch.mjs` — the outside watcher: starts the app, polls for the request, restarts on request.
- `locale/*.json` — title, description, and this page.
- `cordis.patch.yml` — inserts the `restart-button` row.
