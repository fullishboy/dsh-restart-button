/**
 * Host half of the restart button: answers POST /dsh-local/restart-button/request
 * by handing the restart to a detached helper and then stopping this Host.
 *
 * The helper holds one end of a pipe; when this process exits the write end
 * closes and the helper relaunches the desktop executable.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Exact Fetch route the browser button posts to. */
export const ROUTE = '/dsh-local/restart-button/request'

/** Only the connection service can answer the button. */
export const inject = ['connection']

const HELPER = fileURLToPath(new URL('./relaunch.mjs', import.meta.url))

/** Anything the Host reads that says "an agent turn is still working". */
function busyReasons(ctx) {
  const reasons = []
  try {
    const agents = ctx.get('agents')
    const running = agents?.runningSessions?.() ?? agents?.running?.()
    if (Array.isArray(running) && running.length > 0) reasons.push(`${running.length} running session(s)`)
  } catch {
    // A missing or reshaped agent service is not evidence of work.
  }
  return reasons
}

/**
 * @param {object} options
 * @param {string} options.exe desktop executable to start again.
 * @param {string} options.helper path of the detached relaunch helper.
 */
function launchHelper({ exe, helper }) {
  const child = spawn(process.execPath, [helper, JSON.stringify({ exe })], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  child.unref()
}

/** @param {string} file @param {string} line */
function logLine(file, line) {
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Logging must never break the restart.
  }
}

export function apply(ctx) {
  const stateDir = join(ctx.baseDir, 'restart-button')
  const logFile = join(stateDir, 'restart.log')
  mkdirSync(dirname(logFile), { recursive: true })

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const exe = process.env.DSH_NODE_EXECUTABLE
      if (exe === undefined || exe === '') {
        return Response.json({ ok: false, reason: 'not-desktop' }, { status: 409 })
      }
      const busy = busyReasons(ctx)
      if (busy.length > 0) {
        return Response.json({ ok: false, reason: 'busy', busy }, { status: 409 })
      }
      const exit = ctx.get('appExit')
      if (typeof exit !== 'function') {
        return Response.json({ ok: false, reason: 'no-exit' }, { status: 503 })
      }

      const record = { at: new Date().toISOString(), exe, userAgent: request.headers.get('user-agent') }
      try {
        writeFileSync(join(stateDir, 'last-request.json'), `${JSON.stringify(record, null, 2)}\n`)
      } catch {
        // The record is a convenience, not a requirement.
      }
      logLine(logFile, `restart requested exe=${exe}`)

      launchHelper({ exe, helper: HELPER })
      logLine(logFile, 'helper spawned; stopping host')

      exit(0)
      return Response.json({ ok: true, accepted: true }, { status: 202 })
    },
  }), 'restart-button: POST route')
}
