/**
 * Host half of the restart button.
 *
 * Route: POST /api/restart-button/request (same-origin, owner only; exact Fetch routes live under the connection's `/api` prefix and allow [A-Za-z0-9_$.-] segments).
 *
 * Restart path in the desktop app:
 *  1. spawn a detached helper that keeps one end of a pipe;
 *  2. quit cleanly through `ctx.appExit`, which the launcher wires to the
 *     process shutdown controller;
 *  3. the shell sees the Host leave on its own and quits as well;
 *  4. the helper waits for the shell process to disappear, then starts it again.
 *
 * The shell does not relaunch a Host that leaves, so the helper (not the Host)
 * is what brings the app back. A plain web deployment has no shell, so the route
 * answers `not-desktop` there instead of stopping anything.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Exact Fetch route the browser button posts to. */
export const ROUTE = '/api/restart-button/request'

/** Only the connection service can answer the button. */
export const inject = ['connection']

const HELPER = fileURLToPath(new URL('./relaunch.mjs', import.meta.url))

/** `$DSH_HOME/restart-button`, falling back to `~/.dsh/restart-button`. */
function stateDirectory() {
  const fromEnv = process.env.DSH_HOME
  const home = fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
  return join(home, 'restart-button')
}

/**
 * Count the agent turns the Host says are still working.
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

/**
 * Start the detached helper. It holds the read end of a pipe; when this process
 * exits the write end closes and the helper starts the app again.
 * @param options - executable to start again, helper path, and log file.
 */
function launchHelper(options) {
  const child = spawn(process.execPath, [options.helper, JSON.stringify({ exe: options.exe, log: options.log })], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  })
  child.stdin?.end()
  child.unref()
  return child.pid
}

function appendLog(file, line) {
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Logging must never break the restart.
  }
}

export function apply(ctx) {
  const stateDir = stateDirectory()
  const logFile = join(stateDir, 'restart.log')

  ctx.effect(() => {
    try {
      mkdirSync(stateDir, { recursive: true })
    } catch {
      // A read-only home still leaves the button working without logs.
    }
  }, 'restart-button: state directory')

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch() {
      const exe = process.env.DSH_NODE_EXECUTABLE
      if (exe === undefined || exe === '') {
        return Response.json({ ok: false, reason: 'not-desktop' }, { status: 409 })
      }
      const running = runningWork(ctx)
      if (running.length > 0) {
        return Response.json({ ok: false, reason: 'busy', running }, { status: 409 })
      }
      const exit = ctx.get('appExit')
      if (typeof exit !== 'function') {
        return Response.json({ ok: false, reason: 'no-exit' }, { status: 503 })
      }

      let pid
      try {
        pid = launchHelper({ exe, helper: HELPER, log: logFile })
      } catch (error) {
        appendLog(logFile, `helper spawn failed: ${String(error)}`)
        return Response.json({ ok: false, reason: 'helper-failed' }, { status: 500 })
      }

      const record = { at: new Date().toISOString(), exe, helperPid: pid }
      try {
        writeFileSync(join(stateDir, 'last-request.json'), `${JSON.stringify(record, null, 2)}\n`)
      } catch {
        // The record is a convenience, not a requirement.
      }
      appendLog(logFile, `restart requested exe=${exe} helper=${String(pid)}; asking the launcher to stop`)

      // Answer first, then stop: the page needs the 202 before its socket drops.
      setTimeout(() => {
        appendLog(logFile, 'appExit(0)')
        exit(0)
      }, 150)
      return Response.json({ ok: true, accepted: true, helperPid: pid }, { status: 202 })
    },
  }), 'restart-button: POST route')
}
