# Restart button

Adds a **Restart** row to the bottom of the sidebar, directly above Settings.

## What it does

1. One press turns the row into an in-place confirm: **Restart now?** with `Restart` and `Cancel`.
2. `Cancel`, Escape, or a press on the row returns it to idle.
3. `Restart` posts to `/api/restart-button/request` on the shared connection channel, which only an authenticated browser session of this Host can reach.
4. The Host launches a detached helper, starts shutting itself down, and the helper relaunches the desktop executable once the old Host is gone.

## The work guard

Restarting with an agent turn in flight loses that turn, so the row refuses while one runs:

- The row reads the Host session list's `running` flag and shows *A turn is running. Stop it first.* instead of the confirm.
- The Host re-checks the same fact when the request arrives and answers `409 busy` rather than restarting.

## What happens on screen

The desktop shell treats a Host exit as a failure until it sees the end of a quit it asked for, so the shell's **startup failed** dialog appears for a moment, and the helper starts a fresh application about six seconds after the old one leaves. Every DSH plugin that touches processes this way has to live with that dialog; it is the shell's own crash-recovery path, not a restart request.

Two shortcuts that look like a restart are not one: closing the window hides the app to the tray, and quitting from the tray exits without relaunching.

## Install

Copy this directory into a profile and install it as a local bundle:

```sh
dsh plugin add <path-to-this-directory>
```

The row appears after the next start.

## Files

- `index.js` — Host half: registers the exact Fetch route, checks for running turns, records the request, and stops the Host through `appExit`.
- `relaunch.mjs` — the detached helper: waits for the Host pipe to close, waits for the old desktop process to leave, then relaunches the executable.
- `client.js` — Client half: the sidebar-foot row, its in-place confirm, its work guard, and its styles. The glyph is inlined; no Harness UI package is imported.
- `locale/*.json` — title, description, and this page.
- `cordis.patch.yml` — inserts the `restart-button` row.
