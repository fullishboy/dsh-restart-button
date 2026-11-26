/**
 * One-shot restart helper.
 *
 * It is started by `launch-helper.ps1` through `Win32_Process.Create`, so its
 * parent is `WmiPrvSE.exe` and it is *not* a descendant of the app. That is the
 * whole point: `taskkill /T` walks the app's descendants, so a helper started
 * by the app itself would be ended by the very kill it issues.
 *
 * Sequence: announce the pid, give the Host a moment to answer the browser,
 * end the app's tree, wait until it is really gone, start the app again, watch
 * the new instance briefly, then exit. It never stays resident.
 *
 * argv[2] is base64 JSON `{ pid, exe, log, pidFile }` — base64 because the
 * provider parses the command line and quotes would not survive it.
 */
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, rmSync, writeFileSync } from 'node:fs'

/** How long the Host gets to answer the browser before the tree goes away. */
const SETTLE_MS = 1500

/** How long the app may take to disappear after the kill. */
const GONE_TIMEOUT_MS = 20000

/** How long the new instance is watched before the helper calls it a day. */
const WATCH_MS = 6000

/** Poll interval while waiting for the app to disappear. */
const POLL_MS = 200

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

function readPayload() {
  const raw = process.argv[2]
  if (typeof raw !== 'string' || raw === '') throw new Error('no payload argument')
  const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
  const pid = Number(parsed.pid)
  if (!Number.isInteger(pid) || pid <= 4) throw new Error(`unusable target pid: ${String(parsed.pid)}`)
  if (typeof parsed.exe !== 'string' || parsed.exe === '') throw new Error('no executable in the payload')
  return { pid, exe: parsed.exe, log: parsed.log, pidFile: parsed.pidFile }
}

function killTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: error === null || error === undefined, output: `${stdout ?? ''}${stderr ?? ''}`.trim() })
    })
  })
}

async function main() {
  let payload
  try {
    payload = readPayload()
  } catch (error) {
    // Without a usable payload there is nothing to write to and nothing to do.
    process.stderr.write(`restart helper: ${String(error)}\n`)
    process.exit(2)
  }

  const note = (message) => {
    try {
      appendFileSync(payload.log, `${new Date().toISOString()} helper[${process.pid}]: ${message}\n`)
    } catch {
      // Logging must never stop the restart.
    }
  }

  // The Host polls this file to know the helper is really up before it answers
  // the browser; a helper that died on arrival must not be reported as success.
  if (typeof payload.pidFile === 'string' && payload.pidFile !== '') {
    try {
      writeFileSync(payload.pidFile, String(process.pid))
    } catch {
      // A read-only state directory only costs the Host its confirmation.
    }
  }

  note(`launched outside the app tree (parent pid ${process.ppid}); target ${payload.pid}`)
  await delay(SETTLE_MS)

  const killed = await killTree(payload.pid)
  note(killed.ok ? `ended the app tree: ${killed.output.replace(/\r?\n/g, ' | ')}` : `taskkill failed: ${killed.output}`)

  let waited = 0
  while (alive(payload.pid) && waited < GONE_TIMEOUT_MS) {
    await delay(POLL_MS)
    waited += POLL_MS
  }
  if (alive(payload.pid)) {
    note(`the app is still there after ${waited}ms; giving up so nothing is left half-done`)
    process.exit(1)
  }
  note(`the app is gone after ${waited}ms; starting it again`)

  let child
  try {
    // Detached so the new app does not die with this helper.
    child = spawn(payload.exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
  } catch (error) {
    note(`could not start ${payload.exe}: ${String(error)}`)
    process.exit(1)
  }

  note(`started ${payload.exe} as pid ${String(child.pid)}`)
  await delay(WATCH_MS)

  if (!alive(child.pid)) {
    note(`the new instance (pid ${String(child.pid)}) did not survive ${WATCH_MS}ms`)
    process.exit(1)
  }

  note('the new instance is up; the helper is done')
  try {
    if (typeof payload.pidFile === 'string' && payload.pidFile !== '') rmSync(payload.pidFile, { force: true })
  } catch {
    // A stale pid file only makes the next confirmation slower.
  }
  process.exit(0)
}

await main()
