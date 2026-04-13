# codexm launch 设计说明

## 1. 背景

当前 `codexm` 只能管理本地账号快照和当前 `~/.codex/auth.json` 状态，但不能把“切换账号”与“启动 Codex Desktop”串成一个稳定、可用的用户路径。

此前探索过两条更激进的方向：

- 直接热刷新已运行的 Codex Desktop 登录态
- 魔改原始 `Codex.app`，为所有启动注入调试参数

这两条路都不适合作为正式功能：

- 已运行实例的热刷新缺少公开、稳定、低侵入的入口
- 直接修改 `Codex.app` 会破坏签名与升级路径，维护成本高

因此本次功能收敛为一个更稳的正式能力：`codexm launch [account]`。

同时保留对 `switch` 的用户提示优化：

- 如果运行中的 Codex Desktop 是用户手工打开的，`switch` 仍然提示现有桌面实例可能持有旧登录态
- 如果运行中的 Codex Desktop 是由 `codexm launch` 拉起并被 `codexm` 识别为受管实例，则 `switch` 不再重复提示该 warning，而是默认等待当前 thread 结束，再 best-effort 触发一次 `codex-app-server-restart` 让切换生效
- `switch --force` 跳过等待，立即触发该 restart

这条刷新路径的代价也需要明确：

- 受管 Desktop 上的 `switch` 是通过重启 Codex app server 生效的
- 默认 `switch` 会前台等待当前 thread 结束，再执行该 restart
- `switch --force` 会立即打断当前 Desktop 会话里正在进行的 thread / 运行中的交互

## 2. 目标

新增 `codexm launch [account]` 命令，提供一条对用户友好的桌面启动路径：

- 可选先切换到指定账号
- 检测并处理已运行的 Codex Desktop
- 用统一参数启动新的 Codex Desktop 实例
- 不修改原始 `Codex.app`
- 让 `switch` 能区分用户手工打开的 Desktop 与 `codexm launch` 拉起的受管 Desktop
- 让 `switch` 在受管 Desktop 上默认等待当前 thread 完成后再 best-effort 触发一次 app-server restart
- 支持 `switch --force` 立即触发 app-server restart
- 明确该刷新机制会在强制模式下中断当前受管 Desktop 里的进行中 thread

这个命令解决的是“以目标账号启动一个新 Desktop 实例”，不是“给已运行实例做热刷新”。

## 3. 非目标

本次不做以下能力：

- 不承诺热刷新已运行实例的登录态或 quota 显示
- 不修改原始 `Codex.app` 的 bundle、签名或 `Info.plist`
- 不自动下载或安装 Codex Desktop
- 不引入跨平台桌面控制抽象
- 不把远程调试端口暴露为用户配置项

## 4. 用户交互

### 4.1 命令形式

```bash
codexm launch
codexm launch <account>
codexm launch [account] [--json]
```

语义如下：

- `codexm launch`
  - 不切换账号
  - 直接使用当前 `~/.codex/auth.json` 启动 Codex Desktop
- `codexm launch <account>`
  - 先复用现有 `switch` 逻辑切换到 `<account>`
  - 再启动 Codex Desktop

为了与现有 CLI 保持一致，`launch` 支持 `--json` 输出。

### 4.2 已运行实例的处理

如果检测到 Codex Desktop 已经在运行：

1. 向用户展示确认提示
2. 用户确认后，先关闭现有实例
3. 关闭成功后，再启动新实例

如果用户拒绝，则命令直接中止，不做进一步动作。

如果命令运行在非交互终端中，且检测到已有运行中的 Codex Desktop：

- 直接报错
- 不隐式关闭现有实例

这样可以避免在脚本或 CI 场景下出现破坏性的桌面进程操作。

### 4.3 未安装时的处理

如果机器上找不到 `Codex.app`：

- 直接报错
- 不尝试自动下载或安装

## 5. 启动策略

### 5.1 启动方式

统一使用 macOS 的 `open` 启动 Codex Desktop，并附带固定的远程调试端口参数：

```bash
open -na /Applications/Codex.app --args --remote-debugging-port=39223
```

设计原因：

- 不修改原始 app bundle
- 启动行为清晰、可预测
- 为后续桌面联动保留稳定入口

### 5.2 端口策略

本次固定使用单一端口常量，例如 `39223`。

暂不做用户配置，原因是：

- `launch` 的核心价值是“稳定启动”
- 端口配置会增加交互和文档复杂度
- 当前只需要一个稳定的本地入口供后续能力扩展

如果未来出现端口冲突，再单独演进为高级配置。

## 6. 模块设计

### 6.1 职责边界

`AccountStore` 保持现有职责，不承担桌面进程管理。

新增桌面启动集成层，例如：

- `src/codex-desktop-launch.ts`

该模块负责：

- 查找 `Codex.app`
- 检测运行中的 Codex Desktop
- 在需要时关闭现有实例
- 以固定参数启动新实例
- 记录最近一次由 `codexm launch` 成功拉起的 Desktop metadata

CLI 层负责串联：

- 解析命令参数
- 可选调用现有 `switch` 流程
- 调用桌面启动模块

### 6.2 受管 Desktop metadata

为了区分“用户手工打开的 Desktop”和“由 `codexm launch` 拉起的 Desktop”，新增一份轻量状态记录。

建议保存的信息包括：

- `pid`
- `started_at`
- `app_path`
- `remote_debugging_port`
- `managed_by_codexm`

建议放在 `~/.codex-team` 下的状态文件中，与现有状态管理保持同一目录层级。

该记录只表示“最近一次成功由 `codexm launch` 拉起的桌面实例”，不承担通用进程清单职责。

### 6.3 建议接口

建议在桌面启动模块中提供以下边界清晰的方法：

- `findInstalledCodexApp()`
- `findRunningCodexDesktop()`
- `quitRunningCodexDesktop()`
- `launchCodexDesktop()`
- `readManagedDesktopState()`
- `writeManagedDesktopState()`
- `clearManagedDesktopState()`
- `isManagedDesktopRunning()`

这样后续若增加：

- `codexm refresh-app`
- `codexm app-status`
- 通过 DevTools 触发内部消息

都可以复用同一层桌面集成代码，而不污染账号管理逻辑。

## 7. 失败处理

### 7.1 账号切换失败

如果 `codexm launch <account>` 中的账号切换失败：

- 整个命令失败
- 不继续启动 Desktop

### 7.2 已运行实例关闭失败

如果用户已确认重启 Desktop，但旧实例未能关闭：

- 命令失败
- 不继续启动新实例
- 不尝试强杀

原因是强杀过于侵入，而且此前实验已经证明直接对 app-server 或桌面进程施加外部信号容易造成异常状态。

### 7.3 启动失败

如果旧实例已关闭但新实例启动失败：

- 明确报错
- 不自动回滚账号

不回滚的原因：

- `switch` 和 `launch` 是两个独立步骤
- 自动回滚会让最终状态更难理解和排查

### 7.4 受管 Desktop 状态失效

如果记录中的 Desktop metadata 已过期，例如：

- 记录的 PID 不存在
- 记录的命令行不再匹配预期的 Codex Desktop
- 记录缺失关键字段

则将其视为 stale metadata：

- 不再认定当前实例是 `codexm` 受管实例
- 下次 `switch` 如检测到运行中的 Desktop，仍按“用户手工打开”处理并提示 warning
- 下次 `launch` 成功后覆盖旧记录

## 8. 可观测性与输出

命令输出应明确表达三类信息：

- 是否发生账号切换
- 是否处理了现有 Desktop 实例
- 最终是否成功启动新实例

典型输出方向：

- `launch` 无参数成功时：使用当前 auth 启动成功
- `launch <account>` 成功时：先显示切换成功，再显示启动成功
- 已运行实例被用户拒绝关闭时：输出中止信息

`switch` 的 warning 语义也调整为：

- 仅当检测到运行中的、非 `codexm` 受管的 Codex Desktop 时，才输出“现有 session 可能仍持有旧登录态”的提示
- 若当前实例是由 `codexm launch` 拉起的受管实例，则不输出该 warning

## 9. 测试策略

本次以单元测试和 CLI 行为测试为主，不依赖真实 Desktop。

建议覆盖：

- `launch` 无参数时不会触发 `switch`
- `launch <account>` 会先走 `switch`
- 未安装 Codex Desktop 时返回明确错误
- 检测到运行实例时会要求确认
- 用户拒绝确认时命令中止
- 关闭失败时不会继续启动
- 启动命令包含固定远程调试端口参数
- `launch` 成功后会写入受管 Desktop metadata
- `switch` 遇到用户手工打开的 Desktop 时仍会输出 warning
- `switch` 遇到由 `codexm launch` 拉起的受管 Desktop 时不会输出 warning
- stale metadata 不会抑制 `switch` warning

桌面启动模块应尽量设计成可 mock 的外壳，以便测试进程检测、关闭和启动分支。

## 10. 后续扩展

本设计刻意为后续桌面联动留出扩展空间，但不在本次实现：

- 通过固定调试端口查询桌面状态
- 通过 DevTools 协议发送内部消息
- 基于 `window.electronBridge.sendMessageFromView(...)` 做更细的桌面联动

这些能力只有在 `launch` 建立了稳定的桌面启动入口后，才值得继续实现。

## 11. 结论

本次正式功能选择 `codexm launch [account]`，核心原因是：

- 对用户友好
- 不破坏原始 `Codex.app`
- 可维护性明显优于魔改 app 或热刷新黑盒实例
- 已足够覆盖“切账号并启动 Desktop”这一高频使用场景

这是一个范围清晰、实现稳定、后续可扩展的正式方案。
