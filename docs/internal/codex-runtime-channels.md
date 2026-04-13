# codexm 运行时通路说明

这份文档面向维护者，说明 `codexm` 当前和 Codex 运行时交互的两条通路、命令优先级，以及它们各自适合解决的问题。

README 只保留用户可见行为；这里记录设计意图和实现边界。

## 1. 背景总结

`codexm` 先有的是账号快照管理能力，后面逐步补了和 Codex Desktop 的联动能力。

到目前为止，这条演进大致分成两步：

1. `launch / switch / watch`
   - 通过受管 Desktop 状态文件识别由 `codexm` 拉起的桌面实例
   - 通过 DevTools + Electron bridge 读取 Desktop 当前 runtime 信息
   - 通过 `codex-app-server-restart` 在受管 Desktop 上触发切换生效
   - 通过 watch 监听 Desktop 页面里的 bridge 消息流，实时感知 quota 变化

2. direct client 读通路
   - 新增一条直接拉起 `codex app-server` 的 stdio JSON-RPC client
   - 用于一次性读取账号和 quota，不依赖 Desktop 当前前台状态
   - 作为 `current` 等读命令的 fallback，也为后续 `doctor` 铺路

最早的 launch 设计稿在：

- [2026-04-07-codexm-launch-design.md](/Users/bytedance/code/codex-team/docs/superpowers/specs/2026-04-07-codexm-launch-design.md)

这份 internal 文档不重复设计过程，只记录目前代码里的稳定结论。

## 2. 两条通路

### 2.1 Desktop bridge 通路

入口主要在：

- [codex-desktop-launch.ts](/Users/bytedance/code/codex-team/src/codex-desktop-launch.ts)

机制：

1. 通过受管 Desktop metadata 找到 `codexm` 拉起的 Codex Desktop
2. 通过 DevTools websocket 连到 `app://-/index.html?hostId=local`
3. 在页面内执行 JS
4. 由页面里的 `window.electronBridge.sendMessageFromView(...)` 发送 `mcp-request`
5. 通过 bridge 返回 `mcp-response`

它的优势是：看到的是 **Desktop 当前活体 runtime**，而不是磁盘上“理论上应该生效”的 auth 状态。

它适合：

- `current` 的优先读取
- `switch` 等待当前 thread 完成
- 受管 Desktop 上的 app-server restart
- `watch` 这类依赖实时 bridge 消息流的能力

它不适合：

- Desktop 没启动时的一次性读取
- 需要脱离前台 Desktop 的健康检查

### 2.2 direct client 通路

入口主要在：

- [codex-direct-client.ts](/Users/bytedance/code/codex-team/src/codex-direct-client.ts)

机制：

1. 本地直接拉起 `codex app-server`
2. 通过 stdio 按行发送 JSON-RPC
3. 先 `initialize`
4. 再发送一次性读取请求，如 `account/read`、`account/rateLimits/read`
5. 读取完成后关闭子进程

它的优势是：不依赖 Desktop，不需要 DevTools，不要求前台页面活着。

它适合：

- 一次性读取账号信息
- 一次性读取 quota
- 后续 `doctor` 里验证“当前凭据能不能真正跑起来”

它不适合：

- 观察 Desktop 当前 loaded thread 集合
- 观察 Desktop 页面 bridge 实时消息
- 替代 `watch`
- 替代 `switch` 对当前前台 Desktop 的等待与 restart

## 3. 命令优先级

当前约定如下。

### 3.1 `current`

`current` 保持 **Desktop 优先**。

原因：

- 这个命令的语义更接近“当前这台受管 Desktop 里正在跑的 runtime 是谁”
- 如果 Desktop 还没 reload 完，direct client 读到的只是磁盘 auth 对应的新 runtime，不一定等于用户眼前的 Desktop

因此优先级是：

1. 受管 Desktop 可用时，先读 Desktop bridge
2. Desktop 不可用，或 bridge 读取失败时，回退到 direct client
3. 如果这两条都失败，再由更上层决定是否继续回退到本地/usage API

### 3.2 `watch`

`watch` 只走 Desktop bridge。

原因：

- 它依赖 Desktop 页面里桥接出来的 `mcp-request` / `mcp-response` / notification 实时流
- direct client 只能看到自己那次请求的返回值，看不到 Desktop 当前页面正在发生什么

### 3.3 `switch`

`switch` 只走 Desktop bridge。

原因：

- 需要知道 Desktop 当前 loaded threads 里是否还有 active thread
- 需要在受管 Desktop 上发送 `codex-app-server-restart`
- 如果受管 Desktop 当前 runtime 已经是目标账号，则跳过这次 refresh，不做无意义 restart

这两个动作都是 Desktop 运行态动作，不是一次性读取动作。

### 3.4 后续 `doctor`

`doctor` 使用 **direct 优先** 的检查顺序：

推荐分层：

1. 本地 auth/config 文件是否存在且结构合法
2. direct client 能否 `initialize`
3. direct client 能否成功 `account/read`
4. direct client 能否成功 `account/rateLimits/read`
5. 若受管 Desktop 存在，再比对 Desktop runtime 与本地状态是否一致

目前 CLI 上的 `codexm doctor` 落地为：

1. 复用 `store.doctor()` 检查本地存储结构、权限、损坏账号
2. 单独检查当前 `~/.codex/auth.json` 是否缺失或损坏
3. 通过 direct runtime 检查当前凭据是否真的能启动并返回账号信息
4. direct quota probe 失败只记 warning，不直接判定 unhealthy
5. 若受管 Desktop 可读，再补一层 Desktop runtime 与本地 / direct runtime 的 auth mode 一致性告警

退出码约定：

- `0`：没有 issue
- `1`：存在 issue（例如 current auth 缺失 / 损坏，或 direct runtime account probe 失败）

## 4. 命名约定

这次代码里顺手统一了一层命名：

- `RuntimeAccountSnapshot`
- `RuntimeQuotaSnapshot`
- `readCurrentRuntimeAccountResult()`
- `readCurrentRuntimeQuotaResult()`
- `RuntimeReadSource`
- `RuntimeReadResult<T>`

原因是 `current` 这条链路已经不再专属于“managed Desktop”，它需要把 `desktop` / `direct` 来源显式带出来，供 CLI 决定展示和 fallback 逻辑。

同时保留两类读法：

- `readManagedCurrentAccount()`
- `readManagedCurrentQuota()`
- `readCurrentRuntimeAccount()`
- `readCurrentRuntimeQuota()`

语义分别是：

- `readManagedCurrent*`：Desktop-only，给 `watch` / `switch` 这类必须绑定 Desktop 活体状态的逻辑使用
- `readCurrentRuntime*Result`：Desktop 优先，direct fallback，并显式返回来源
- `readCurrentRuntime*`：只是对 `readCurrentRuntime*Result` 的无来源简化包装

## 5. 维护边界

后续如果再加读取类能力，默认先问两个问题：

1. 它读的是“Desktop 当前活体状态”吗？
2. 它是否需要实时事件流，而不是一次性结果？

如果答案是：

- **是**：优先放到 Desktop bridge
- **否**：优先考虑 direct client

不要在同一个操作里无差别同时跑两条通路；必须先定义主语义，再决定谁优先、谁 fallback。

当前仓库里的稳定边界就是：

- `current`：Desktop 优先，direct fallback
- `watch`：Desktop only
- `switch`：Desktop only
- `doctor`：direct 优先，Desktop 只做补充一致性检查
