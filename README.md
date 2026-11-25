# 朴素的重启按钮 · Restart button

一个给 DeepSeek Harness 桌面版加的重启按钮，方便调试运行环境使用。

A plain restart button for DeepSeek Harness Desktop, made for debugging the runtime environment.

[中文](#中文) · [English](#english)

---

## 中文

侧栏底部、设置上方多一行 **重启**。

### 为什么叫“朴素”

没有花哨的东西：一行字，点一下就地变成 `重启` / `取消` 两个选项。按 Esc、点取消、或再点一次这行，都回到原样。防误触就靠这一层二段确认，没有长按、没有连点计数、没有额外的弹窗。

### 为什么需要一个外面的监管进程

桌面版是 Electron 外壳包着一个 Host 进程，两者都没法自己重启外壳：

- 插件跑在 Host 里，够不到 `app.relaunch()`——那个调用只存在于外壳的开发菜单和崩溃恢复对话框里。
- Host 在外壳还等着它的时候离开，外壳会当成崩溃，弹出 **应用无法启动或已意外停止**，那不是重启。

所以重启的决定放在应用外面。`supervisor/dsh-watch.mjs` 启动 `DeepSeek Harness.exe` 并等它，这行请求重启时再启动一次。

监管进程也能接管你手动打开的应用：请求会指向当前持有单实例锁的那个实例，所以只要监管在跑，从资源管理器打开的应用一样能重启。它做不到的是：没有应用在跑、又没有监管进程时，凭空启动一个。

应用已经开着时再启动一次拿不到单实例锁，会立刻退出；监管会以最长 30 秒的退避一直重试，每一轮都写进 `watch.log`，永不放弃。退避期间来的请求会立刻处理，不会再等完剩下的时间。

### 它会做什么

1. 按钮先问 Host 的会话列表有没有正在跑的对话。有的话显示 **有对话正在运行，请先停止。**，不展开确认。
2. 点 `重启` 会 POST 到 `/api/restart-button/request`，走共享连接通道，只有这个 Host 的已认证浏览器会话能到达。
3. Host 再查一次有没有在跑的对话，然后写 `~/.dsh/restart-button/restart-request.json`。有对话在跑时它回 `409 busy` 而不是写文件——守卫不依赖页面以为什么。没有监管进程在跑时回 `409 no-supervisor`。
4. 监管进程一秒内看到这个文件，结束当前持有单实例锁的那个实例及其子进程，等锁释放，再启动新实例。中间不会有恢复对话框，因为这是整棵进程树正常结束，而不是外壳还在跑时 Host 凭空消失。

### 你会看到

窗口关掉，一两秒后回来，端口变了，中间没有对话框。

有两个看着像重启、其实不是的操作：关窗口只是隐藏到托盘，从托盘退出只退出不重启。

### 安装

```sh
dsh plugin add <这个目录的路径>
```

然后重启一次 DSH，这行会出现在侧栏底部。

**不要用包名装。** `@dsh-local/` 是本地范围，npm 上没有它；必须用路径或 Git 地址：

```sh
dsh plugin add github:fullishboy/dsh-restart-button
```

用 Git 地址时，装进去的是 `package.json` 的 `files` 白名单里的文件，所以这个包必须是自足
的：`client.js` 把文案、样式、图标全部自带，`package.json` 里也没有任何运行时依赖。

如果装完侧栏没有这行，先看 `plugin_manager` 里 `restart-button` 是不是 `fiberPhase: active`
（Host 侧是否起来了），再看浏览器控制台有没有 `[restart-button] registering the restart row`
（客户端是否起来了）。两者都没有，就是没装上，不是没渲染。

要让这行真能重启，必须有监管进程在跑。最简单的办法是通过它启动应用：双击 `start-dsh.bat`（它指向应用自带的 Node 运行时），或者自己跑：

```sh
node supervisor/dsh-watch.mjs [--exe "C:\path\to\DeepSeek Harness.exe"]
```

那个启动器的控制台窗口要留着：关掉它监管就停了，这行会变回 *请用 dsh-watch.mjs 启动，才能这样重启。*

### 完全不开窗口地运行

控制台窗口是上面这个办法唯一的毛病，而不小心关掉它，看起来就跟“按钮坏了”一模一样。用计划任务可以避开：

1. `run-hidden.vbs` 用 `WScript.Shell.Run(..., 0, False)` 启动命令，**完全不创建控制台窗口**。
2. 把任务注册成运行 `wscript.exe`，参数是 `run-hidden.vbs <node.exe 路径> <dsh-watch.mjs 路径>`。

`schtasks /TR` 有 261 字符上限，这些路径会超，所以用 PowerShell 注册：

```powershell
$svc = New-Object -ComObject Schedule.Service; $svc.Connect()
$def = $svc.NewTask(0)
$def.Settings.Hidden = $true
$def.Settings.ExecutionTimeLimit = 'PT0S'
$def.Principal.LogonType = 3          # 交互令牌：应用才看得见
$def.Principal.RunLevel  = 1
$a = $def.Actions.Create(0)
$a.Path      = 'C:\Windows\System32\wscript.exe'
$a.Arguments = '"<目录>\run-hidden.vbs" "<node.exe 所在目录>" "<目录>\supervisor\dsh-watch.mjs"'
$svc.GetFolder('\').RegisterTaskDefinition('dsh-watch', $def, 6, $null, $null, 3) | Out-Null
Start-ScheduledTask -TaskName 'dsh-watch'
```

**不要**为了隐藏窗口把 principal 设成服务账户（`LogonType` 5）：那样监管会把应用启动到 session 0 里，你根本看不见它。`wscript` 才能两头都要——监管无窗口，应用正常可见。

想开机就有，再给这个任务加一个登录触发器（`$def.Triggers.Create(9)`，可以给个 `Delay = 'PT15S'`）。

### 它是怎么构成的

- `index.js` — Host 半边。注册精确的 Fetch 路由，查有没有在跑的会话，写请求文件。它从不停止 Host。
- `client.js` — Client 半边。侧栏底部那一行、就地确认、基于 Host 会话列表的工作守卫，以及它自己的 CSS。刷新图标是内联的：Harness 的 UI 包被打进 web 前端，没有暴露给插件 bundle。
- `supervisor/dsh-watch.mjs` — 外面的监管进程：启动应用，轮询请求文件，按请求重启。
- `run-hidden.vbs` — 无窗口启动器，给计划任务用。
- `locale/en.json`、`locale/zh.json` — 标题、描述和本页。
- `cordis.patch.yml` — 插入 `restart-button` 这一行。

状态放在 `~/.dsh/restart-button/`：`watch.pid`（监管写，退出时删）、`restart-request.json`（Host 写，监管消费）、`restart.log`、`watch.log`。Host 在接受重启前会确认 `watch.pid` 里的进程还活着，所以被关掉的监管不会留下一个“接受请求但没人处理”的按钮。

### 限制

- 仅桌面版，且需要有监管进程在跑（应用通过 `supervisor/dsh-watch.mjs` 启动，或监管已接管手工打开的实例）。
- 重启会杀掉进行中的对话，所以才有那道守卫。
- 监管用 `taskkill /T` 结束应用，所以在应用进程树下启动的东西都会一起结束。
- 从托盘退出仍然只是退出、不重启；这行负责重启，不取代退出。

---

## English

A **Restart** row appears at the bottom of the sidebar, right above Settings.

### Why "plain"

Nothing clever: one row that turns into an in-place confirm — `Restart` and `Cancel`. Escape, `Cancel`, or a second press on the row returns it to idle. That two-step confirm is the whole anti-mistake design — no long press, no counting clicks, no separate dialog.

### Why there is a supervisor

The desktop app is an Electron shell around a Host process, and neither one can restart the shell on request:

- A plugin runs inside the Host and cannot reach `app.relaunch()`; that call lives only in the shell's development menu and its crash-recovery dialog.
- If the Host leaves while the shell still expects it, the shell treats that as a crash and shows **Application failed to start or stopped unexpectedly** — not a restart.

So the restart decision sits outside the app. `supervisor/dsh-watch.mjs` starts `DeepSeek Harness.exe`, waits for it, and starts it again when the row asks for one.

The supervisor can also take over an app you opened by hand: a request names whatever instance currently holds the single-instance lock, so the row works even for an app started from Explorer, as long as a supervisor process is around. What it cannot do is start the app when none is running and no supervisor exists.

A second start while the app is already open cannot obtain the single-instance lock, so it exits at once; the supervisor retries with a backoff that tops out at 30 seconds and never gives up, logging each round in `watch.log`. A request that arrives during a backoff is honoured immediately rather than after the wait.

### What it does

1. The row asks the Host session list whether any agent turn is running. If one is, the row says **A turn is running. Stop it first.** and refuses to open the confirm.
2. `Restart` posts to `/api/restart-button/request` on the shared connection channel, which only an authenticated browser session of this Host can reach.
3. The Host re-checks for running turns, then writes `~/.dsh/restart-button/restart-request.json`. It answers `409 busy` instead of writing while a turn runs, so the guard does not depend on what the page believed. It answers `409 no-supervisor` when no watcher is running.
4. The supervisor sees the file within a second, ends whichever instance currently holds the single-instance lock (not only a child it started itself), together with its children, waits for the lock to clear, and starts a fresh instance. No recovery dialog is involved, because the exit is a normal end of the process tree rather than a Host that vanished under a running shell.

### What you see

The window closes and comes back after a couple of seconds, on a new port, with no dialog in between.

Two shortcuts that look like a restart are not one: closing the window hides the app to the tray, and quitting from the tray exits without restarting.

### Install

```sh
dsh plugin add <path-to-this-directory>
```

Then start DSH once more; the row appears in the sidebar foot.

**Do not install it by package name.** `@dsh-local/` is a local scope that the npm registry does not have; use a path or the Git address instead:

```sh
dsh plugin add github:fullishboy/dsh-restart-button
```

A Git install ships only what `package.json` lists in `files`, which is why this package is self-contained: `client.js` carries its own copy, styles and glyph, and `package.json` declares no runtime dependency.

If the row is missing after installing, check first that `plugin_manager` shows `restart-button` as `fiberPhase: active` (the host half came up), then that the browser console carries `[restart-button] registering the restart row` (the client half came up). Neither means the package did not install; it does not mean the row failed to render.

For the row to actually restart anything, a supervisor must be running. The simplest way is to launch the app through it: double-click `start-dsh.bat`, which points at the app's own bundled Node runtime, or run it yourself:

```sh
node supervisor/dsh-watch.mjs [--exe "C:\path\to\DeepSeek Harness.exe"]
```

Keep that launcher's console window open: closing it stops the supervisor, and the row goes back to *Start the app through dsh-watch.mjs to use this.*

### Running it with no window at all

A console window is the one drawback of the launcher above, and closing it by accident looks exactly like "the button stopped working". A Scheduled Task avoids that:

1. `run-hidden.vbs` starts a command with `WScript.Shell.Run(..., 0, False)`, which creates **no console window at all**.
2. Register the task to run `wscript.exe` with `run-hidden.vbs <node.exe> <path-to-dsh-watch.mjs>`.

`schtasks /TR` is capped at 261 characters, which those paths exceed, so register through PowerShell:

```powershell
$svc = New-Object -ComObject Schedule.Service; $svc.Connect()
$def = $svc.NewTask(0)
$def.Settings.Hidden = $true
$def.Settings.ExecutionTimeLimit = 'PT0S'
$def.Principal.LogonType = 3          # interactive token: the app stays visible
$def.Principal.RunLevel  = 1
$a = $def.Actions.Create(0)
$a.Path      = 'C:\Windows\System32\wscript.exe'
$a.Arguments = '"<dir>\run-hidden.vbs" "<dir-to-node.exe>" "<dir>\supervisor\dsh-watch.mjs"'
$svc.GetFolder('\').RegisterTaskDefinition('dsh-watch', $def, 6, $null, $null, 3) | Out-Null
Start-ScheduledTask -TaskName 'dsh-watch'
```

Do **not** set the principal to a service account (`LogonType` 5) to hide the window: the supervisor would then spawn the app in session 0, where you cannot see it. `wscript` is the way to get both — no window for the supervisor, a normal visible app.

To have it after every login, add a logon trigger to the same task (`$def.Triggers.Create(9)`, optionally with `Delay = 'PT15S'`).

### How it is built

- `index.js` — Host half. Registers the exact Fetch route, checks for running sessions, writes the request file. It never stops the Host.
- `client.js` — Client half. The sidebar-foot row, its in-place confirm, the work guard over the Host session list, and its own CSS. The refresh glyph is inlined: the Harness UI packages are bundled into the web frontend rather than exposed to plugin bundles.
- `supervisor/dsh-watch.mjs` — the outside watcher: starts the app, polls for the request file, restarts on request.
- `run-hidden.vbs` — the windowless launcher the Scheduled Task runs.
- `locale/en.json`, `locale/zh.json` — title, description, and this page.
- `cordis.patch.yml` — inserts the `restart-button` row.

State lives in `~/.dsh/restart-button/`: `watch.pid` (written by the supervisor, removed when it exits), `restart-request.json` (written by the Host, consumed by the supervisor), `restart.log`, `watch.log`. The Host checks that the pid in `watch.pid` is still alive before accepting a restart, so a supervisor that was killed does not leave the row accepting requests nobody will act on.

### Limits

- Desktop only, and only while a supervisor is running (the app was started through `supervisor/dsh-watch.mjs`, or the supervisor has taken over a hand-opened instance).
- A restart kills in-flight turns, which is why the guard exists.
- The supervisor ends the app with `taskkill /T`, so anything else started under the app process tree ends with it.
- Quitting from the tray still exits without restarting; the row restarts, it does not replace quitting.
