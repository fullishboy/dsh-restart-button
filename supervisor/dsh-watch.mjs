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
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const POLL_MS = 500
/** Pause after the old instance is gone, so its single-instance lock is released. */
const RELAUNCH_DELAY_MS = 1200

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

/** Whether the app process we started has left. */
function stillRunning(child) {
  return child.exitCode === null && child.signalCode === null
}

/** Supervise one app instance until it exits, restarting it when asked. */
async function supervise() {
  let child = startApp()
  let requested = false

  const poll = setInterval(async () => {
    const request = takeRequest()
    if (request === undefined) return
    // A request that arrives while the app is going down is served by the next
    // instance; only act on one we can act on now.
    if (!stillRunning(child)) return
    requested = true
    clearInterval(poll)
    log(`restart requested (${String(request.reason ?? 'unknown')}); ending pid=${String(child.pid)}`)
    await endApp(child.pid)
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

  for (;;) {
    const { code, requested } = await supervise()
    if (!requested) {
      log(`supervisor exiting code=${String(code)}`)
      process.exit(code)
    }
    await delay(RELAUNCH_DELAY_MS)
  }
}

mkdirSync(dirname(requestFile), { recursive: true })
writeFileSync(join(dirname(requestFile), 'watch.pid'), `${String(process.pid)}\n`)

main().catch((error) => {
  log(`supervisor crashed: ${String(error)}`)
  process.exit(1)
})
