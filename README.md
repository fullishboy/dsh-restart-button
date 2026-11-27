# 朴素的重启按钮 · Restart button

一个给 DeepSeek Harness 桌面版加的重启按钮，方便调试运行环境使用。

A plain restart button for DeepSeek Harness Desktop, made for debugging the runtime environment.

[中文](#中文) · [English](#english)

---

## 中文

侧栏底部、设置上方多一行 **重启**。点一下就地变成 `重启` / `取消`，确认后应用关掉、自己再起来。

### 为什么叫“朴素”

没有花哨的东西：一行字，点一下就地变成 `重启` / `取消` 两个选项。按 Esc、点取消、或再点一次这行，都回到原样。防误触就靠这一层二段确认，没有长按、没有连点计数、没有额外的弹窗。

### 为什么按钮不能自己重启

桌面版是 Electron 外壳包着一个 Host 进程，插件跑在 Host 里：

- 够不到 `app.relaunch()`——那个调用只存在于外壳的开发菜单和崩溃恢复对话框里，插件所在的进程没有它。
- Host 在外壳还等着它的时候离开，外壳会当成崩溃，弹出 **应用无法启动或已意外停止**，那不是重启。
- 就算另起一个助手进程去杀外壳也没用：`spawn(detached)` 只改变会话和进程组，**不改变父进程记录**，助手仍然是应用的子孙进程。`taskkill /T` 是按进程树删的，于是助手被自己发出的那个 kill 一起删掉，没有人再去启动新实例。

这一条是踩了很多次才认下来的：看着像“关掉了但没起来”，实际上是助手先死。

### 做法：借 WMI 生一个树外的助手

按钮被按下的那一刻，Host 通过 `Win32_Process.Create` 起一个一次性助手（`supervisor/launch-helper.ps1` 负责这一步）。这样创建出来的进程：

- **父进程是 `WmiPrvSE.exe`**，从诞生起就在应用的进程树之外，`taskkill /T` 够不着它；
- **继承调用方的令牌**，桌面版以什么权限跑，助手就是什么权限——权限低了杀不动外壳，这一点靠继承天然解决；
- 只活一次，做完就退出，不常驻。

顺序是：助手先写好 `helper.pid` 报到 → Host 确认它真活着 → Host 回 `202` → 助手等 1.5 秒（让浏览器收到回复）→ `taskkill /PID <外壳> /T /F` → 轮询确认整棵树消失 → 启动新的 `DeepSeek Harness.exe` → 观察 6 秒 → 退出。

### 它会做什么

1. 按钮先问 Host 的会话列表有没有正在跑的对话。有的话显示 **有对话正在运行，请先停止。**，不展开确认。
2. 点 `重启` 会 POST 到 `/api/restart-button/request`，走共享连接通道，只有这个 Host 的已认证浏览器会话能到达。
3. Host 再查一次有没有在跑的对话——守卫不依赖页面以为什么。然后经 WMI 起助手，等它报到，回 `202`。
4. 助手结束整棵进程树并启动新实例。外壳在同一瞬间消失，没有机会渲染恢复对话框。

### 你会看到

窗口消失，约一秒后自己回来，端口变了，中间没有对话框。

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

**注意 npm 上有个同名包。** 注册表里的 `dsh-restart-button`（作者 `jiqiu`，最新 `0.1.2`，仓库 `jiqiu0709/dsh-restart-button`）是**别人写的另一个插件**，只是名字像。手输 `dsh plugin add dsh-restart-button` 装到的是它：依赖里会出现 `dsh-restart-button: ^0.1.2`，侧栏却什么都不会出现 —— 这不是本项目装坏了，是装错了东西。

装对了的判据只有一条：profile 的 `package.json` 里依赖名是 **`@dsh-local/restart-button`**，值是路径或 `github:fullishboy/...`。

用 Git 地址时，装进去的是 `package.json` 的 `files` 白名单里的文件，所以这个包必须是自足的：`client.js` 把文案、样式、图标全部自带，`package.json` 里也没有任何运行时依赖。

如果装完侧栏没有这行，先看 `plugin_manager` 里 `restart-button` 是不是 `fiberPhase: active`（Host 侧是否起来了），再看浏览器控制台有没有 `[restart-button] registering the restart row`（客户端是否起来了）。两者都没有，就是没装上，不是没渲染。

### 它是怎么构成的

- `index.js` — Host 半边。注册精确的 Fetch 路由，查有没有在跑的会话，经 WMI 起助手并确认它报到了。它自己不结束任何进程。
- `client.js` — Client 半边。侧栏底部那一行、就地确认、基于 Host 会话列表的工作守卫，以及它自己的 CSS。刷新图标是内联的：Harness 的 UI 包被打进 web 前端，没有暴露给插件 bundle。
- `supervisor/launch-helper.ps1` — 调 `Win32_Process.Create` 起助手。`ShowWindow` 必须显式给成 `uint16`，否则 provider 报类型不匹配，助手会带一个控制台窗口。
- `supervisor/dsh-watch.mjs` — 一次性助手：结束进程树、重启、观察、退出。
- `locale/en.json`、`locale/zh.json` — 标题、描述和本页。
- `cordis.patch.yml` — 插入 `restart-button` 这一行。

状态放在 `~/.dsh/restart-button/`：`helper.pid`（助手写，退出时删）、`restart.log`（两边都写，排查先看它）。

`node.exe` 的位置是从应用根目录推导的（`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`），不是 `process.execPath`：Host 以 `ELECTRON_RUN_AS_NODE` 跑在应用自己的可执行文件里，`process.execPath` 指向的是应用本身，拿它去起助手等于又开一个应用实例，撞上单实例锁就立刻退出。

### 限制

- 仅桌面版，仅 Windows（用到 WMI 和 `taskkill`）。
- 重启会杀掉进行中的对话，所以才有那道守卫。
- 助手用 `taskkill /T` 结束应用，所以在应用进程树下启动的东西都会一起结束。
- 从托盘退出仍然只是退出、不重启；这行负责重启，不取代退出。

---

## English

A **Restart** row appears at the bottom of the sidebar, right above Settings. One press turns it into `Restart` / `Cancel`; the confirmed restart closes the app and brings it back.

### Why "plain"

Nothing clever: one row that turns into an in-place confirm — `Restart` and `Cancel`. Escape, `Cancel`, or a second press on the row returns it to idle. That two-step confirm is the whole anti-mistake design — no long press, no counting clicks, no separate dialog.

### Why the button cannot restart the app by itself

The desktop app is an Electron shell around a Host process, and the plugin runs inside the Host:

- It cannot reach `app.relaunch()`. That call lives only in the shell's development menu and its crash-recovery dialog, and the plugin's process does not have it.
- If the Host leaves while the shell still expects it, the shell treats that as a crash and shows **Application failed to start or stopped unexpectedly** — not a restart.
- Starting a helper process to kill the shell does not help either. `spawn(detached)` changes the session and the process group but **not the recorded parent**, so the helper is still a descendant of the app. `taskkill /T` deletes by process tree, so the helper is deleted by the very kill it issued and nothing is left to start a new instance.

That last point is the one that took several tries to accept: it looks like "it closed and did not come back", but really the helper died first.

### How it works: a helper born outside the tree

The moment the row is confirmed, the Host starts a one-shot helper through `Win32_Process.Create` (that is what `supervisor/launch-helper.ps1` does). A process created that way:

- **has `WmiPrvSE.exe` as its parent**, so it is outside the app's process tree from birth and `taskkill /T` cannot reach it;
- **inherits the caller's token**, so a helper for an app running elevated is itself elevated — a weaker helper could not end the shell, and inheritance settles that on its own;
- lives exactly once: it does its job and exits, it does not stay resident.

The order is: the helper writes `helper.pid` to announce itself → the Host confirms it is really alive → the Host answers `202` → the helper waits 1.5 s so the browser gets that answer → `taskkill /PID <shell> /T /F` → polls until the whole tree is gone → starts a fresh `DeepSeek Harness.exe` → watches it for 6 s → exits.

### What it does

1. The row asks the Host session list whether any agent turn is running. If one is, the row says **A turn is running. Stop it first.** and refuses to open the confirm.
2. `Restart` posts to `/api/restart-button/request` on the shared connection channel, which only an authenticated browser session of this Host can reach.
3. The Host re-checks for running turns — the guard does not depend on what the page believed — then creates the helper through WMI, waits for it to announce itself, and answers `202`.
4. The helper ends the whole process tree and starts a new instance. The shell disappears in the same instant, so it never gets to render a recovery dialog.

### What you see

The window closes and comes back after about a second, on a new port, with no dialog in between.

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

**Another plugin on npm carries almost this name.** The registry has `dsh-restart-button` (by `jiqiu`, latest `0.1.2`, repo `jiqiu0709/dsh-restart-button`) — a different plugin by a different author, not this one. Typing `dsh plugin add dsh-restart-button` installs that package: the profile gets `dsh-restart-button: ^0.1.2`, and no row ever appears. Nothing is broken; the wrong package was installed.

The only reliable check is the dependency name: it has to be **`@dsh-local/restart-button`**, with a path or `github:fullishboy/...` as its value.

If the row is missing after installing, check first that `plugin_manager` shows `restart-button` as `fiberPhase: active` (the host half came up), then that the browser console carries `[restart-button] registering the restart row` (the client half came up). Neither means the package did not install; it does not mean the row failed to render.

### How it is built

- `index.js` — Host half. Registers the exact Fetch route, checks for running sessions, creates the helper through WMI and waits for it to announce itself. It ends no process itself.
- `client.js` — Client half. The sidebar-foot row, its in-place confirm, the work guard over the Host session list, and its own CSS. The refresh glyph is inlined: the Harness UI packages are bundled into the web frontend rather than exposed to plugin bundles.
- `supervisor/launch-helper.ps1` — calls `Win32_Process.Create` to start the helper. `ShowWindow` has to be given as `uint16` or the provider rejects the request with a type mismatch, and the helper arrives with a console window.
- `supervisor/dsh-watch.mjs` — the one-shot helper: ends the tree, restarts, watches, exits.
- `locale/en.json`, `locale/zh.json` — title, description, and this page.
- `cordis.patch.yml` — inserts the `restart-button` row.

State lives in `~/.dsh/restart-button/`: `helper.pid` (written by the helper, removed when it exits) and `restart.log` (written by both halves; look there first when something goes wrong).

`node.exe` is derived from the app root (`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`), never from `process.execPath`: the Host runs under `ELECTRON_RUN_AS_NODE` inside the app's own executable, so `process.execPath` is the app itself. Handing that to the launcher starts a second app instance, which dies on the single-instance lock.

### Limits

- Desktop only, and Windows only (it uses WMI and `taskkill`).
- A restart kills in-flight turns, which is why the guard exists.
- The helper ends the app with `taskkill /T`, so anything else started under the app process tree ends with it.
- Quitting from the tray still exits without restarting; the row restarts, it does not replace quitting.
