/**
 * Detached relaunch helper: starts the desktop executable once the Host that
 * spawned it has exited and the previous desktop process is gone.
 *
 * Usage: electron-runtime relaunch.mjs '{"exe":"C:\\...\\DeepSeek Harness.exe"}'
 *
 * The runtime keeps `process.stdin` open, so the pipe stays open while the Host
 * lives and reports end-of-stream when it exits. A hard deadline covers the case
 * where the pipe never closes.
 */

import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const DEADLINE_MS = 20000
const POLL_MS = 200
const SETTLE_MS = 6000

let options
try {
  options = JSON.parse(process.argv[2] ?? '{}')
} catch {
  process.exit(2)
}

const exe = options.exe
if (typeof exe !== 'string' || exe === '') process.exit(3)

const logFile = options.log
let exited = false
let started = false

function log(line) {
  if (typeof logFile !== 'string') return
  try {
    appendFileSync(logFile, `${new Date().toISOString()} helper ${line}\n`)
  } catch {
    // ignore
  }
}

/** Whether the desktop executable still has a live process. */
function desktopAlive() {
  if (process.platform !== 'win32') return false
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + basename(), '/NH'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    })
    return out.toLowerCase().includes(basename().toLowerCase())
  } catch {
    return false
  }
}

function basename() {
  return exe.split(/[\\/]/).pop() ?? exe
}

function relaunch() {
  if (started) return
  started = true
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    log(`relaunched ${exe}`)
  } catch (error) {
    log(`relaunch failed: ${String(error)}`)
  }
  setTimeout(() => process.exit(0), 1000)
}

/** Wait until the desktop process leaves the table, then bounce it back. */
function waitDesktopGone(startedAt) {
  if (Date.now() - startedAt > SETTLE_MS) {
    relaunch()
    return
  }
  if (!desktopAlive()) {
    relaunch()
    return
  }
  setTimeout(() => waitDesktopGone(startedAt), POLL_MS)
}

process.stdin.on('end', () => {
  exited = true
  log('host pipe closed')
  waitDesktopGone(Date.now())
})
process.stdin.on('close', () => {
  exited = true
  waitDesktopGone(Date.now())
})
process.stdin.resume()

setTimeout(() => {
  if (!exited) log('deadline reached before the host exited')
  waitDesktopGone(Date.now())
}, DEADLINE_MS)
