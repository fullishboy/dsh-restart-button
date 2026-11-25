/**
 * One-shot restart helper, spawned by the plugin when the button is pressed.
 *
 * It runs outside the app's process tree (the plugin spawns it detached), so it
 * can end the app and start it again without killing itself: `taskkill /T` walks
 * the parent chain, and this process is not on it.
 *
 * Lifecycle: end the app -> wait for it to go -> start it again -> watch the new
 * process for a few seconds -> exit. It never stays resident, so a later press
 * spawns a fresh one.
 *
 * Usage: node dsh-watch.mjs '{"pid":1234,"exe":"...","log":"...","pidFile":"..."}'
 */
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { dirname } from 'node:path'

/** How long a killed process may take to disappear. */
const GONE_TIMEOUT_MS = 20000
/** How long the new instance must survive before the restart counts. */
const SETTLE_MS = 6000
const POLL_MS = 200

const options = (() => {
  try {
    return JSON.parse(process.argv[2] ?? '{}')
  } catch {
    return {}
  }
})()

const logFile = typeof options.log === 'string' ? options.log : undefined
const pidFile = typeof options.pidFile === 'string' ? options.pidFile : undefined

function log(line) {
  if (logFile === undefined) return
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    appendFileSync(logFile, `${new Date().toISOString()} [helper] ${line}\n`)
  } catch {
    // Logging must never break the restart.
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether a process is still there; EPERM means it exists but is not ours. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function waitGone(pid, budgetMs) {
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    if (!alive(pid)) return true
    await delay(POLL_MS)
  }
  return !alive(pid)
}

/** End the whole tree, so the Electron shell and Host go together. */
function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    log(`taskkill ${pid} done`)
  } catch (error) {
    log(`taskkill ${pid} failed: ${String(error?.message ?? error)}`)
  }
}

function announce() {
  if (pidFile === undefined) return
  try {
    mkdirSync(dirname(pidFile), { recursive: true })
    writeFileSync(pidFile, `${process.pid}\n`)
    log(`announced pid ${process.pid}`)
  } catch {
    // The app waits for this file; a failure shows up as a refused restart.
  }
}

function clearAnnouncement() {
  if (pidFile === undefined) return
  try {
    if (existsSync(pidFile)) rmSync(pidFile, { force: true })
  } catch {
    // A leftover pid file is ignored by the next helper.
  }
}

async function main() {
  announce()

  const target = Number.parseInt(String(options.pid ?? ''), 10)
  const exe = typeof options.exe === 'string' ? options.exe : ''
  if (!Number.isInteger(target) || target <= 0) {
    log('no target pid; nothing to restart')
    return 1
  }
  if (exe === '') {
    log('no executable path; nothing to start')
    return 1
  }

  log(`restarting ${target}`)
  killTree(target)
  if (!(await waitGone(target, GONE_TIMEOUT_MS))) {
    log(`pid ${target} is still running after ${GONE_TIMEOUT_MS} ms; giving up`)
    return 1
  }
  log(`pid ${target} is gone`)

  // Nothing holds the single-instance lock now, so this launch owns it.
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true })
  const started = child.pid
  log(`started ${exe} pid=${String(started)}`)
  child.unref()

  if (!Number.isInteger(started) || started <= 0) {
    log('the launcher did not report a pid')
    return 1
  }

  await delay(SETTLE_MS)
  if (alive(started)) {
    log(`pid ${started} survived ${SETTLE_MS} ms; restart done`)
    return 0
  }
  log(`pid ${started} exited within ${SETTLE_MS} ms; the app did not come back`)
  return 1
}

main()
  .catch((error) => {
    log(`crashed: ${String(error?.stack ?? error)}`)
    return 1
  })
  .finally(() => {
    clearAnnouncement()
    log('helper exiting')
    process.exit(0)
  })
