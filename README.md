# Restart button

A DeepSeek Harness Desktop plugin that puts a **Restart** row at the bottom of the sidebar, right above Settings.

Press it once and the row turns into an in-place confirm: `Restart` and `Cancel`. Escape, `Cancel`, or a second press on the row returns it to idle. That two-step confirm is the whole anti-mistake design — no long press, no counting clicks, no separate dialog.

## What it does

1. The row asks the Host list whether any agent turn is running. If one is, the row says **A turn is running. Stop it first.** and refuses to open the confirm.
2. `Restart` posts to `/dsh-local/restart-button/request` on the shared API channel, which only an authenticated browser session can reach.
3. The Host launches a detached helper and starts shutting itself down.
4. The helper waits for the old Host to leave and for the previous desktop process to exit, then starts `DeepSeek Harness.exe` again.

The Host re-checks for running turns when the request arrives and answers `409 busy` instead of restarting, so the guard does not depend on what the page believed.

## What you see

The desktop shell treats every Host exit as a failure until it sees the end of a quit it asked for, so its **startup failed** dialog flashes for a moment before the helper brings a fresh instance back. A plugin cannot call `app.relaunch()`: that lives only in the shell's crash-recovery dialog and its development menu. Every plugin that restarts DSH this way lives with that dialog.

## Install

```sh
dsh plugin add <path-to-this-directory>
```

Then start DSH once more; the row appears in the sidebar foot.

## How it is built

- `index.js` — Host half. Registers the exact Fetch route, checks for running sessions, records the request, stops the Host through the `appExit` command-line service.
- `relaunch.mjs` — detached helper. Waits for the Host pipe to close, polls `tasklist` for the old executable, then relaunches it.
- `client.js` — Client half. The sidebar-foot row, its in-place confirm, the work guard over the standard `useSessions` hook, and its own CSS. The refresh glyph is inlined: the Harness UI packages are bundled into the web frontend rather than exposed to plugin bundles.
- `locale/en.json`, `locale/zh.json` — title, description, and this page.
- `cordis.patch.yml` — inserts the `restart-button` row.

## Limits

- Desktop only. Without `DSH_NODE_EXECUTABLE` the Host answers `409 not-desktop`.
- A restart kills in-flight turns, which is why the guard exists.
- Quitting from the tray still exits without relaunching; the row restarts, it does not replace quitting.
