/**
 * Host half of the restart button.
 *
 * Route: POST /api/restart-button/request (same-origin, owner only; exact Fetch
 * routes live under the connection's `/api` prefix and allow [A-Za-z0-9_$.-]
 * segments).
 *
 * The button cannot restart the app from inside it. The desktop shell treats a
 * Host that leaves on its own as a crash — the "startup failed" dialog — and a
 * plugin cannot reach `app.relaunch()` from the Host at all. So this route only
 * leaves a request behind in `$DSH_HOME/restart-button/restart-request.json`,
 * and the supervisor the user launched the app with (`supervisor/dsh-watch.mjs`)
 * is what ends the app and starts it again. Without that supervisor watching,
 * the request file simply sits there and nothing happens.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Exact Fetch route the browser button posts to. */
export const ROUTE = '/api/restart-button/request'

/** Only the connection service can answer the button. */
export const inject = ['connection']

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

/** Whether a supervisor from `supervisor/dsh-watch.mjs` is watching this home. */
function supervisorRunning(stateDir) {
  if (!existsSync(join(stateDir, 'watch.pid'))) return false
  return true
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
  const requestFile = join(stateDir, 'restart-request.json')

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
      appendLog(logFile, `request received exe=${String(process.env.DSH_NODE_EXECUTABLE)}`)
      if (!supervisorRunning(stateDir)) {
        // Nothing outside the app is watching, so a request would only strand.
        return Response.json({ ok: false, reason: 'no-supervisor' }, { status: 409 })
      }
      const running = runningWork(ctx)
      if (running.length > 0) {
        return Response.json({ ok: false, reason: 'busy', running }, { status: 409 })
      }

      const record = {
        at: new Date().toISOString(),
        reason: 'button',
        pid: process.pid,
        host: process.env.DSH_DESKTOP_HOST_PORT ?? '',
      }
      try {
        writeFileSync(requestFile, `${JSON.stringify(record, null, 2)}\n`)
      } catch (error) {
        appendLog(logFile, `could not write the request: ${String(error)}`)
        return Response.json({ ok: false, reason: 'request-failed' }, { status: 500 })
      }
      appendLog(logFile, `restart requested; supervisor picks it up within a second`)
      return Response.json({ ok: true, accepted: true }, { status: 202 })
    },
  }

  // Register once the web listener exists: the connection service refuses a
  // route before it knows the origin it will be served from.
  const register = () => ctx.effect(() => ctx.connection.fetch.register(route), 'restart-button: POST route')
  ctx.inject(['webServer'], (child) => {
    child.effect(register, 'restart-button: route registration')
  })
}
