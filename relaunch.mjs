/**
 * Detached relaunch helper for `@dsh-local/restart-button`.
 *
 * Usage: <node> relaunch.mjs '{"exe":"C:\\...\\DeepSeek Harness.exe","log":"C:\\...\\restart.log"}'
 *
 * The Host spawns this with a pipe and keeps the write end open, so `stdin`
 * reports end-of-stream exactly when the Host goes away. After that the helper
 * waits for the desktop shell process to leave the process table and starts it
 * again. A deadline covers the case where the pipe never closes.
 */

import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

/** Give up on the pipe and act anyway. */
const DEADLINE_MS = 30000
/** How long the shell may stay in the process table before we relaunch anyway. */
const SHELL_SETTLE_MS = 15000
/** Keep polling after the shell leaves, so a late crash dialog cannot eat the relaunch. */
const RELAUNCH_RETRY_MS = 1200
const POLL_MS = 200

let options
try {
  options = JSON.parse(process.argv[2] ?? '{}')
} catch {
  process.exit(2)
}

const exe = options.exe
if (typeof exe !== 'string' || exe === '') process.exit(3)

const logFile = options.log
const name = exe.split(/[\\/]/).pop() ?? exe
/** Set once the relaunch attempt has been made, so the pipe cannot double-fire. */
let acting = false
/** Set when the host is gone and the shell has already been waited for. */
let waiting = false

function log(line) {
  if (typeof logFile !== 'string') return
  try {
    appendFileSync(logFile, `${new Date().toISOString()} helper ${line}\n`)
  } catch {
    // Logging is best effort.
  }
}

/** Whether the desktop shell still owns a live process. */
function shellAlive() {
  if (process.platform !== 'win32') return false
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    })
    return out.toLowerCase().includes(name.toLowerCase())
  } catch {
    // An unreadable process table is not proof the shell is gone; wait it out.
    return true
  }
}

function relaunch() {
  if (acting) return
  acting = true
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    log(`relaunched ${exe}`)
  } catch (error) {
    log(`relaunch failed: ${String(error)}`)
    acting = false
    setTimeout(relaunch, RELAUNCH_RETRY_MS)
    return
  }
  setTimeout(() => process.exit(0), 4000)
}

/**
 * Poll the process table until the shell is gone.
 * @param startedAt - when the wait began, used for the settle window.
 */
function waitForShellExit(startedAt) {
  if (Date.now() - startedAt > SHELL_SETTLE_MS) {
    log('shell still running after the settle window; relaunching anyway')
    relaunch()
    return
  }
  if (!shellAlive()) {
    log('shell exited')
    relaunch()
    return
  }
  setTimeout(() => waitForShellExit(startedAt), POLL_MS)
}

function hostGone(reason) {
  if (waiting || acting) return
  waiting = true
  log(`host pipe closed (${reason})`)
  waitForShellExit(Date.now())
}

process.stdin.on('end', () => hostGone('end'))
process.stdin.on('close', () => hostGone('close'))
process.stdin.on('error', () => hostGone('error'))
process.stdin.resume()

setTimeout(() => {
  hostGone('deadline')
}, DEADLINE_MS)
