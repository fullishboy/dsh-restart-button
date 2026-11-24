/**
 * DeepSeek Harness supervisor — the piece that makes the sidebar "Restart"
 * button possible without patching the installed app.
 *
 * The app is an Electron shell plus a Host process. Nothing inside either one
 * may restart the shell on request: the shell treats a Host that leaves on its
 * own as a crash (that is the "startup failed" dialog), and a plugin cannot
 * reach `app.relaunch()` from the Host. So the restart decision has to live
 * outside the app, and this process is that outside:
 *
 *   1. it starts DeepSeek Harness.exe and waits for it;
 *   2. the sidebar button posts to the plugin, which drops a request file;
 *   3. this watcher sees the file, ends the app it started, and starts it again
 *      — a normal command-line start, with no recovery dialog.
 *
 * Run it instead of DeepSeek Harness.exe (shortcut, or `node dsh-watch.mjs`).
 * With no request file it behaves exactly like the app launcher: start, wait,
 * exit with the app's code.
 *
 * Usage: node dsh-watch.mjs [--exe <path>] [--request <path>] [--log <path>]
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const POLL_MS = 500
/** Pause after the old instance is gone, so its single-instance lock is released. */
const RELAUNCH_DELAY_MS = 1200
/**
 * An app that stays up less than this did not really start: it exited at once
 * because another instance held the single-instance lock.
 */
const IMMEDIATE_EXIT_MS = 4000
/**
 * How long to wait before trying again after such an exit. Another instance
 * holds the single-instance lock only while it runs, and the user may keep it
 * open for as long as they like, so the supervisor waits instead of giving up:
 * every quick exit means "someone else is still there", not "this is broken".
 */
const RETRY_DELAY_MS = 2000
/** Ceiling for the backoff, so an idle wait costs nothing but is still quick to notice. */
const MAX_RETRY_DELAY_MS = 30000

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--exe') options.exe = argv[index + 1]
    else if (flag === '--request') options.request = argv[index + 1]
    else if (flag === '--log') options.log = argv[index + 1]
  }
  return options
}

const stateDir = join(homedir(), '.dsh', 'restart-button')
const args = parseArgs(process.argv.slice(2))
const exe = args.exe ?? process.env.DSH_WATCH_EXE ?? defaultExe()
const requestFile = args.request ?? join(stateDir, 'restart-request.json')
const logFile = args.log ?? join(stateDir, 'watch.log')

/** The packaged app, in the per-user Programs directory Windows installers use. */
function defaultExe() {
  const local = process.env.LOCALAPPDATA
  if (local !== undefined && local !== '') {
    return join(local, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
  }
  return 'DeepSeek Harness.exe'
}

function log(line) {
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    appendFileSync(logFile, `${new Date().toISOString()} watch ${line}\n`)
  } catch {
    // Logging is never allowed to break the launch.
  }
}

/** Take the request file if one is waiting. */
function takeRequest() {
  if (!existsSync(requestFile)) return undefined
  let request
  try {
    request = JSON.parse(readFileSync(requestFile, 'utf8'))
  } catch {
    request = { reason: 'unreadable' }
  }
  try {
    rmSync(requestFile, { force: true })
  } catch {
    // Kept for the next poll when it cannot be removed.
  }
  return request
}

function startApp() {
  const child = spawn(exe, [], { stdio: 'ignore', windowsHide: false })
  log(`started ${exe} pid=${String(child.pid)}`)
  return child
}

/**
 * End the app and its children. `taskkill /T` walks the tree, so the Electron
 * renderers and the Host go with it and nothing is left holding the profile.
 * @param pid - the pid `startApp` returned.
 */
function endApp(pid) {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.once('exit', (code) => {
      log(`taskkill pid=${String(pid)} exit=${String(code)}`)
      resolve()
    })
    killer.once('error', (error) => {
      log(`taskkill failed: ${String(error)}`)
      resolve()
    })
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Sleep a backoff while still listening for a restart request. Waiting out the
 * whole backoff would leave a button press unanswered for up to 30 seconds, and
 * the press is exactly what a user expects to be honoured right away.
 * @param ms - the backoff for this round.
 * @returns the request, when one arrived during the wait.
 */
async function waitForRequest(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const request = takeRequest()
    if (request !== undefined) return request
    await delay(POLL_MS)
  }
  return undefined
}

/** Whether the app process we started has left. */
function stillRunning(child) {
  return child.exitCode === null && child.signalCode === null
}

/** The process name the app runs under, without the .exe the file system adds. */
function appProcessName() {
  const base = basename(exe)
  return base.toLowerCase().endsWith('.exe') ? base.slice(0, -4) : base
}

/**
 * The app process that currently owns the single-instance lock — the one with a
 * visible window. This matters because the app the user opens by hand is not the
 * child this supervisor started: that child exits at once while the hand-opened
 * one keeps running, so supervising only our own child would never end it.
 * @returns the pid, or undefined when no app instance is running.
 */
function runningAppPid() {
  const script =
    `Get-Process -Name '${appProcessName()}' -ErrorAction SilentlyContinue | ` +
    'Where-Object { $_.MainWindowHandle -ne 0 } | ' +
    'Select-Object -First 1 -ExpandProperty Id'
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    }).trim()
    const pid = Number.parseInt(out, 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** Supervise one app instance until it exits, restarting it when asked. */
async function supervise() {
  let child = startApp()
  let requested = false

  const poll = setInterval(async () => {
    const request = takeRequest()
    if (request === undefined) return
    // The app may have been opened by hand, so the target is whatever instance
    // holds the single-instance lock right now, not only the child we spawned.
    const target = stillRunning(child) ? child.pid : runningAppPid()
    if (target === undefined) {
      // Nothing is up: the next instance start serves this request instead.
      log(`restart requested (${String(request.reason ?? 'unknown')}) but no app is running; it will start fresh`)
      requested = true
      clearInterval(poll)
      return
    }
    requested = true
    clearInterval(poll)
    log(`restart requested (${String(request.reason ?? 'unknown')}); ending pid=${String(target)}`)
    await endApp(target)
  }, POLL_MS)

  const code = await new Promise((resolve) => {
    child.once('exit', (value, signal) => {
      log(`app exited code=${String(value)} signal=${String(signal)}`)
      resolve(value ?? 0)
    })
    child.once('error', (error) => {
      log(`app failed to start: ${String(error)}`)
      resolve(1)
    })
  })

  clearInterval(poll)
  return { code, requested }
}

async function main() {
  log(`supervisor starting exe=${exe} request=${requestFile}`)
  if (!existsSync(exe)) {
    log(`executable not found: ${exe}`)
    process.exit(2)
  }
  // A request left behind by an earlier crash must not restart anything.
  rmSync(requestFile, { force: true })
  writeFileSync(join(dirname(requestFile), 'watch.pid'), `${String(process.pid)}\n`)

  // Starts that die at once mean another instance holds the single-instance
  // lock, which is the normal situation when this runs beside an app the user
  // opened by hand. Waiting is the whole point: the moment that instance goes
  // away, the next attempt takes over. Probing the process table for "is
  // another instance up" is what caused a launch storm before, so the evidence
  // used here is only the app's own lifetime.
  let quickFailures = 0

  for (;;) {
    const startedAt = Date.now()
    const { code, requested } = await supervise()
    if (requested) {
      quickFailures = 0
      await delay(RELAUNCH_DELAY_MS)
      continue
    }

    const lasted = Date.now() - startedAt
    if (lasted >= IMMEDIATE_EXIT_MS) {
      // A real session ended on its own: the supervisor's job is done.
      log(`supervisor exiting code=${String(code)}`)
      process.exit(code)
    }

    quickFailures += 1
    // Back off towards a slow pulse so a long open session costs almost nothing,
    // but never stop: the app cannot start until the other instance is gone.
    const wait = Math.min(RETRY_DELAY_MS * quickFailures, MAX_RETRY_DELAY_MS)
    log(
      `the app exited at once (${String(quickFailures)} in a row); ` +
        `another instance is probably already running - waiting ${String(Math.round(wait / 1000))}s`,
    )
    // A request can arrive during the backoff: honour it now instead of after
    // the whole wait, by ending whichever instance currently holds the lock.
    const duringWait = await waitForRequest(wait)
    if (duringWait !== undefined) {
      const target = runningAppPid()
      if (target === undefined) {
        log(`restart requested (${String(duringWait.reason ?? 'unknown')}) but no app is running; starting one`)
      } else {
        log(`restart requested (${String(duringWait.reason ?? 'unknown')}); ending pid=${String(target)}`)
        await endApp(target)
      }
      quickFailures = 0
      await delay(RELAUNCH_DELAY_MS)
      continue
    }
  }
}

const pidFile = join(dirname(requestFile), 'watch.pid')

/** Drop the pid file, so the plugin stops believing a supervisor is watching. */
function clearPidFile() {
  try {
    if (!existsSync(pidFile)) return
    if (Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10) === process.pid) rmSync(pidFile, { force: true })
  } catch {
    // Nothing to do: the plugin also checks the pid is alive.
  }
}

mkdirSync(dirname(requestFile), { recursive: true })
writeFileSync(pidFile, `${String(process.pid)}\n`)
process.on('exit', clearPidFile)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    clearPidFile()
    process.exit(0)
  })
}

process.on('exit', (code) => log(`supervisor process exiting code=${String(code)} pid=${String(process.pid)}`))

main().catch((error) => {
  log(`supervisor crashed: ${String(error)}`)
  process.exit(1)
})
