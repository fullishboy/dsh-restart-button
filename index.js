/**
 * Host half of the restart button.
 *
 * Route: POST /api/restart-button/request (same-origin, owner only; exact Fetch
 * routes live under the connection's `/api` prefix and allow [A-Za-z0-9_$.-]
 * segments).
 *
 * A plugin cannot restart the app from inside it: the desktop shell treats a
 * Host that leaves on its own as a crash, and `app.relaunch()` is out of reach.
 * So this route spawns `supervisor/dsh-watch.mjs` detached — outside the app's
 * process tree — waits until that helper announces itself, and only then ends
 * this process. The helper does the rest: it ends the app's tree, starts the
 * executable again, watches the new instance for a few seconds, and exits.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Name of the packaged desktop executable. */
const APP_EXECUTABLE = 'DeepSeek Harness.exe'

/** Exact Fetch route the browser button posts to. */
export const ROUTE = '/api/restart-button/request'

/** Only the connection service can answer the button. */
export const inject = ['connection']

/** The helper that runs outside the app tree. */
const HELPER = fileURLToPath(new URL('./supervisor/dsh-watch.mjs', import.meta.url))

/** How long the helper may take to announce itself. */
const ANNOUNCE_TIMEOUT_MS = 10000

/** `$DSH_HOME/restart-button`, falling back to `~/.dsh/restart-button`. */
function stateDirectory() {
  const fromEnv = process.env.DSH_HOME
  const home = fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
  return join(home, 'restart-button')
}

/**
 * The turns the Host says are still working.
 * @param ctx - plugin context; the agent table is looked up through it.
 */
function runningWork(ctx) {
  const running = []
  try {
    const agents = ctx.get('agents')
    const sessions = agents?.runningSessions?.() ?? agents?.running?.()
    if (Array.isArray(sessions)) running.push(...sessions.map((entry) => String(entry)))
  } catch {
    // A missing or reshaped agent table is not evidence of work.
  }
  return running
}

function appendLog(file, line) {
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
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

/** Read the pid the helper wrote, if any. */
function announcedPid(pidFile) {
  try {
    if (!existsSync(pidFile)) return Number.NaN
    return Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
  } catch {
    return Number.NaN
  }
}

/**
 * The packaged executable that runs this profile, or undefined off-desktop.
 *
 * The Desktop Host starts the profile with `argv[2]` set to the dsh directory
 * inside `app.asar` (`<root>/resources/app.asar/dsh`), and its own environment
 * carries `DSH_DESKTOP_NODE_EXECUTABLE` — the bundled Node, not the app. So the
 * executable is derived from the packaged layout, never looked up in the PATH.
 */
function applicationExecutable() {
  const candidates = []
  const dshDirectory = process.argv[2]
  if (typeof dshDirectory === 'string' && dshDirectory !== '') {
    candidates.push(join(dirname(dshDirectory), '..', '..', '..', APP_EXECUTABLE))
  }
  const localAppData = process.env.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData !== '') {
    candidates.push(join(localAppData, 'Programs', 'DeepSeek Harness', APP_EXECUTABLE))
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // A malformed candidate is simply skipped.
    }
  }
  return undefined
}

export function apply(ctx) {
  const stateDir = stateDirectory()
  const logFile = join(stateDir, 'restart.log')
  const pidFile = join(stateDir, 'helper.pid')

  ctx.effect(() => {
    try {
      mkdirSync(stateDir, { recursive: true })
    } catch {
      // A read-only home still leaves the button working without logs.
    }
  }, 'restart-button: state directory')

  const route = {
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch() {
      const running = runningWork(ctx)
      if (running.length > 0) {
        appendLog(logFile, `refused: ${running.length} turn(s) still running`)
        return Response.json({ ok: false, reason: 'busy', running }, { status: 409 })
      }

      const exe = applicationExecutable()
      if (exe === undefined) {
        appendLog(logFile, `refused: no ${APP_EXECUTABLE} next to the profile; this is not the packaged desktop app`)
        return Response.json({ ok: false, reason: 'not-desktop' }, { status: 409 })
      }
      appendLog(logFile, `executable resolved: ${exe}`)

      // A leftover announcement from an earlier helper must not be mistaken for
      // the one this request starts.
      try {
        if (existsSync(pidFile)) rmSync(pidFile, { force: true })
      } catch {
        // Nothing else reads it before the new helper writes.
      }

      // The helper ends the Electron main process, which takes this Host down
      // with it. The Host is the shell's direct child, so the shell is our own
      // parent; refusing a pid of 0 or 4 keeps a broken launch from being read
      // as "kill the tree I am standing in".
      const shellPid = process.ppid
      if (!Number.isInteger(shellPid) || shellPid <= 4) {
        appendLog(logFile, `refused: cannot identify the desktop shell (ppid=${String(shellPid)})`)
        return Response.json({ ok: false, reason: 'not-desktop' }, { status: 409 })
      }

      const payload = JSON.stringify({ pid: shellPid, exe, log: logFile, pidFile })
      let helperPid = Number.NaN
      try {
        const child = spawn(process.execPath, [HELPER, payload], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        })
        helperPid = child.pid ?? Number.NaN
        child.unref()
      } catch (error) {
        appendLog(logFile, `could not start the helper: ${String(error)}`)
        return Response.json({ ok: false, reason: 'helper-failed' }, { status: 500 })
      }
      appendLog(logFile, `helper spawned pid=${String(helperPid)} for shell pid=${String(shellPid)}`)

      // Confirm the helper is up before handing the app over: the helper kills
      // this process tree, so a helper that never started would leave nothing
      // to bring the app back.
      const until = Date.now() + ANNOUNCE_TIMEOUT_MS
      let confirmed = false
      while (Date.now() < until) {
        const announced = announcedPid(pidFile)
        if (alive(announced)) {
          confirmed = true
          break
        }
        await delay(100)
      }
      if (!confirmed) {
        appendLog(logFile, 'the helper never announced itself; the app stays up')
        return Response.json({ ok: false, reason: 'helper-failed' }, { status: 500 })
      }

      appendLog(logFile, 'handing over to the helper; it ends this tree and starts the app again')
      return Response.json({ ok: true, accepted: true, helperPid }, { status: 202 })
    },
  }

  // Register once the web listener exists: the connection service refuses a
  // route before it knows the origin it will be served from.
  const register = () => ctx.effect(() => ctx.connection.fetch.register(route), 'restart-button: POST route')
  ctx.inject(['webServer'], (child) => {
    child.effect(register, 'restart-button: route registration')
  })
}
