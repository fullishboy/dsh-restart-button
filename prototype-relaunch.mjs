/**
 * Prototype: prove the relaunch handshake without touching the plugin.
 *
 *   node prototype-relaunch.mjs            # dry: show what it would do
 *   node prototype-relaunch.mjs --go --stop <pid>   # really quit and relaunch
 *
 * The helper is the plugin's `relaunch.mjs`. It holds the read end of a pipe;
 * this process owns the write end and closes it by exiting, which is exactly
 * what the Host does when the launcher stops it.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const go = args.includes('--go')
const stopIndex = args.indexOf('--stop')
const stopPid = stopIndex >= 0 ? Number(args[stopIndex + 1]) : undefined

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const stateDir = join(home, 'restart-button')
mkdirSync(stateDir, { recursive: true })
const logFile = join(stateDir, 'prototype.log')
const helperLog = join(stateDir, 'prototype-helper.log')

function log(line) {
  const text = `${new Date().toISOString()} node ${line}`
  console.log(text)
  try {
    appendFileSync(logFile, `${text}\n`)
  } catch {}
}

const exe = process.env.DSH_NODE_EXECUTABLE
log(`exe=${String(exe)} pid=${String(process.pid)}`)
if (exe === undefined) {
  log('DSH_NODE_EXECUTABLE is not set; run this through the plugin host half instead.')
  process.exit(2)
}

if (!go) {
  log(`dry: would spawn ${join(here, 'relaunch.mjs')} and then close the pipe`)
  if (stopPid !== undefined) log(`dry: would stop pid ${String(stopPid)} afterwards`)
  process.exit(0)
}

// Double-fork: our own child exits at once and leaves the helper behind, so the
// helper inherits no console, no window, and no handle from this process.
const child = spawn(
  process.execPath,
  [join(here, 'relaunch.mjs'), JSON.stringify({ exe, log: helperLog })],
  { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true },
)
log(`helper spawned pid=${String(child.pid)}`)
child.stdin.end()
child.unref()

if (stopPid !== undefined) {
  setTimeout(() => {
    try {
      process.kill(stopPid)
      log(`sent SIGTERM to ${String(stopPid)}`)
    } catch (error) {
      log(`stop failed: ${String(error)}`)
    }
    setTimeout(() => process.exit(0), 300)
  }, 500)
} else {
  setTimeout(() => process.exit(0), 300)
}
