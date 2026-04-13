# Codex Desktop Windows 通路 TODO

这份文档记录 `codexm` 把 Desktop 通路扩到 Windows 时，需要补的依赖、平台适配点和建议落地顺序。

它不是正式设计稿，只作为后续实现前的内部 TODO 清单。

## 1. 当前结论

现在 `codexm` 的 Desktop 通路本质上分两层：

1. Desktop 进程管理层
   - 找到已安装的 Codex Desktop
   - 枚举运行中的 Desktop 进程
   - 判断当前 shell 是否跑在 Desktop 内
   - 退出和重启 Desktop
   - 记录和校验受管 Desktop 状态

2. Desktop runtime 交互层
   - 通过 DevTools websocket 连到 `app://-/index.html?hostId=local`
   - 在页面内执行 JS
   - 通过 `window.electronBridge.sendMessageFromView(...)` 走 bridge
   - 读取 runtime account / quota
   - 触发 `codex-app-server-restart`
   - 监听 bridge 消息流做 `watch`

当前上层 runtime 交互逻辑没有明显的平台绑定，主要的 macOS 假设都集中在 Desktop 进程管理层。

## 2. 现有 macOS-only 假设

当前实现里，这些点默认是 macOS 专属：

1. 安装路径
   - `/Applications/Codex.app`
   - `~/Applications/Codex.app`
   - `mdfind "Codex.app"`

2. 可执行文件路径
   - `.../Contents/MacOS/Codex`

3. 进程枚举
   - `ps -Ao pid=,command=`

4. 父进程链判断
   - 通过 `ps -o ppid=,command= -p <pid>` 逐层向上找 Desktop

5. 优雅退出
   - `osascript -e 'tell application "Codex" to quit'`

6. 错误提示
   - 直接写死了 `/Applications/Codex.app`

这些都需要 Win32 适配。

## 3. Windows 版最小依赖

从当前代码结构看，Windows Desktop 通路不需要额外 npm 依赖，最小依赖应控制在：

- Windows 上已安装 Codex Desktop
- Desktop 可执行文件支持 `--remote-debugging-port=<port>`
- 本机可访问 `http://127.0.0.1:<port>/json/list`
- Desktop 页面仍暴露：
  - `app://-/index.html?hostId=local`
  - `window.electronBridge.sendMessageFromView(...)`
- 系统自带命令可用：
  - `powershell` 或 `pwsh`
  - `taskkill`
  - `cmd.exe`

换句话说，真正要补的是平台适配，不是新的通信协议。

## 4. 建议实现方式

建议先把 Desktop 进程管理抽成平台层，不要继续把 `if (process.platform === ...)` 散落在主逻辑里。

建议拆成：

- `desktop-platform-darwin.ts`
- `desktop-platform-win32.ts`

至少抽出这几个动作：

- `findInstalledApp()`
- `listRunningApps()`
- `isRunningInsideDesktopShell()`
- `quitRunningApps()`
- `launch()`

然后由 `createCodexDesktopLauncher()` 只负责组装平台实现和上层 runtime 逻辑。

## 5. Windows v1 落地范围

第一版只追求“能用”，不追求最优雅。

### 5.1 查找安装路径

优先尝试常见路径，例如：

- `%LocalAppData%\\Programs\\Codex\\Codex.exe`
- `%ProgramFiles%\\Codex\\Codex.exe`
- `%ProgramFiles(x86)%\\Codex\\Codex.exe`

如果这些都失败，再考虑：

- 开始菜单快捷方式解析
- 注册表查询

第一版可以只做常见路径探测。

### 5.2 枚举进程

建议用 PowerShell 查询进程和命令行，例如：

- `Get-CimInstance Win32_Process`

需要拿到：

- `ProcessId`
- `CommandLine`

因为后面还要校验：

- 是否真的是 Codex Desktop
- 是否带了指定的 `--remote-debugging-port`

### 5.3 判断当前是否跑在 Desktop 内

同样建议沿着父进程链向上查，只是实现改成 Windows 版本。

可以继续保留现有语义：

- 如果当前 CLI 是从 Codex Desktop 内部开的，就拒绝执行 `launch`

### 5.4 退出 Desktop

Windows v1 不强求优雅退出。

建议：

- 普通退出：先尝试 `taskkill /PID <pid> /T`
- force 退出：`taskkill /PID <pid> /T /F`

如果后面验证发现存在更稳定的非强杀退出方式，再单独补。

### 5.5 启动 Desktop

直接 `spawn` Windows 可执行文件，例如：

- `Codex.exe --remote-debugging-port=39223`

并保留：

- detached
- 隐藏控制台窗口

### 5.6 复用现有 bridge / watch / restart

只要 Windows 版 Desktop 保留现有这些运行时能力：

- DevTools websocket
- `app://-/index.html?hostId=local`
- `electronBridge`

那么以下能力应尽量直接复用：

- `current` 的 Desktop 优先读取
- `switch` 的 managed refresh
- `watch` 的 bridge 监听
- `codex-app-server-restart`

不要为 Windows 重写第二套上层逻辑。

## 6. 建议实施顺序

建议按下面顺序做：

1. 先抽平台层接口
2. 保持 darwin 行为不变
3. 补 win32 的：
   - app 查找
   - 进程枚举
   - kill / launch
4. 跑通 Windows 上的：
   - `launch`
   - `current`
   - `watch`
   - `switch`
5. 最后再考虑：
   - 更优雅的退出
   - 更稳的安装路径发现

不要一开始就碰 Linux。

## 7. 风险点

后续真正实现前，需要确认这些前提：

1. Windows 版 Codex Desktop 是否也支持 `--remote-debugging-port`
2. DevTools `/json/list` 是否同样暴露目标页面
3. 目标页面 URL 是否仍是 `app://-/index.html?hostId=local`
4. `electronBridge.sendMessageFromView(...)` 是否保持同名
5. `codex-app-server-restart` 在 Windows Desktop 上是否可用

如果这些运行时前提有任何一项变化，就不是单纯的平台适配，而是需要补协议兼容层。

## 8. 验收标准

Windows Desktop 通路做完后，至少要满足：

1. `codexm launch` 能找到并启动 Windows 版 Codex Desktop
2. `codexm launch` 能记录受管 Desktop 状态
3. `codexm current` 在受管 Desktop 存在时，仍优先走 Desktop runtime
4. `codexm watch` 能收到 quota 更新
5. `codexm switch` 能在受管 Desktop 上触发 refresh
6. 在 Codex Desktop 内部 shell 中，`launch` 仍会拒绝重启自己
7. macOS 现有行为不回归

## 9. 后续实现备注

真正开做时，建议先补一份正式 spec，再实现，不要直接按这页 TODO 开写。
