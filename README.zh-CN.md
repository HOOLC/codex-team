# codex-team

[English](./README.md) | [简体中文](./README.zh-CN.md)

`codex-team` 提供 `codexm` 命令，用来在一台机器上管理多个 Codex ChatGPT 登录快照。

如果你经常在多个 Codex 账号之间切换，它可以帮你更简单地：

- 保存多个命名账号快照
- 切换当前生效的 `~/.codex/auth.json`
- 查看多个账号的 quota 使用情况
- 导出和导入完全信任前提下的分享 bundle，而不需要重新登录
- 在当前账号耗尽时自动切号并重启运行中的 Codex
- 为 Codex 和 OpenAI-compatible 工具提供一个本地 proxy 账号

## 平台支持

| 平台 | 状态 | 说明 |
|------|------|------|
| macOS | ✅ 完整支持 | 支持 Desktop 启动、watch 和全部 CLI 命令 |
| Linux | ✅ 完整支持 | 仅 CLI 模式；Desktop 相关命令会优雅降级 |
| WSL | ✅ 完整支持 | 支持 WSL 浏览器打开链路；仅 CLI 模式 |

## 安装

```bash
npm install -g codex-team
```

安装完成后，使用 `codexm` 命令。

## 可选 Agent Skill

这个仓库还维护了一个可选的 agent skill，面向支持从 GitHub 安装 `SKILL.md` bundle 的 coding agent。它不是运行 `codexm` 的必需依赖；npm 包只分发 CLI runtime 和库入口。

任何兼容的 coding agent 都可以从 GitHub 安装同一个 `skills/codexm-usage` 路径。如果你用的是 Codex 内置的 GitHub skill installer，可以把 skill 固定到与你安装的 CLI 对应的 release tag：

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-installer/scripts/install-skill-from-github.py" \
  --repo HOOLC/codex-team \
  --path skills/codexm-usage \
  --ref v0.0.20
```

请把 `--ref` 替换成与你安装的 CLI 版本对应的 release tag。如果你的 coding agent 会缓存已安装 skill，安装后请重启或重新加载它。

## 快速开始

### 1. 先保存几个账号并看概览

```bash
codexm add plus1
codexm add team1
codexm list
codexm usage
```

`codexm list` 用来看账号概览，`codexm usage` 用来看本地 session 日志里的 token usage 和 estimated cost。

### 2. 打开 dashboard

```bash
codexm
```

dashboard 里常用按键：

- `Enter`：切号
- `a`：启用或关闭 daemon 驱动的 autoswitch
- `f`：在当前账号上 reload，或强制切号
- `p`：切换“是否允许自动切号选中该账号”的保护状态
- `o`：在当前终端运行 `codex`，退出后回到 dashboard
- `O`：用隔离的托管快照运行 `codex`，退出后回到 dashboard
- `d`：打开或聚焦 Codex Desktop，但不离开 dashboard
- `Shift+D`：用选中账号重新拉起 Codex Desktop；如果当前已有非 `codexm` 托管的 Desktop，会先确认再强制关闭重启

### 3. 让它持续自动工作

macOS + Codex Desktop：

```bash
codexm launch
codexm autoswitch enable
```

Linux / WSL + Codex CLI：

```bash
codexm watch
```

在另一个终端里通过 wrapper 启动 Codex：

```bash
codexm run -- --model o3
```

`codexm launch` 会启动 Desktop 并确保共享 baseline daemon 已运行，`codexm autoswitch enable` 会开启 daemon 驱动的后台自动切号。`codexm watch` 仍然是前台 quota 监控命令；`codexm run` 会包装 `codex` CLI，能够在 `~/.codex/auth.json` 被重复原子替换后继续自动重启，并在账号切换触发重启后自动恢复当前交互会话。如果你手动结束 `codexm run` 且当前 session 可恢复，它会打印可直接使用的恢复命令。

### 4. 使用本地 proxy 账号

```bash
codexm proxy enable
codexm proxy status
codexm run --proxy -- --model o3
codexm proxy disable
```

`codexm proxy enable` 会在 `127.0.0.1` 启动本地 daemon，写入一个 synthetic ChatGPT auth（`proxy@codexm.local`），并把本地 auth/config 指向这个 proxy。live config 现在会保留内建 provider 身份，只改 transport URL，所以 proxy 和非 proxy 会继续共用同一份 live thread 历史。dashboard 和 `codexm list` 总会显示一个 `proxy` 行，它的 quota 来自真实池：统计未保护、允许 auto-switch 且仍保留 quota 快照的账号，包含已经耗尽的账号，这样整个池子都归零时也会继续显示 `0%`，不会直接消失；受保护账号不计入。Codex Desktop 里的 usage/account 读取现在也会保持在同一个 synthetic proxy 账号视图上，不再因为最近一次命中的真实 upstream 而漂移。它的 `5H`、`1W` 和 `ETA` 都基于这个池子的真实剩余额度聚合，消耗速率仍然沿用用户全局 watch 历史。启用 proxy 模式后，这个 synthetic 账号会成为默认 `CODEX_HOME` 的当前账号。proxy 选路现在会默认跟随保存的 direct/current upstream，而不是每条消息都重新排序：`codexm switch <name>` 会立刻成为 proxy 的当前上游；如果后续 daemon 因 quota 耗尽信号触发 autoswitch，proxy 才会再跟着切走。现在只要 daemon autoswitch 开启，proxy 在遇到可重试的 quota exhausted 失败且尚未向下游输出内容时，还会自动重放一次 `/v1/responses` websocket turn 或一条缓冲型 REST 请求（`stream: false` 的 `/v1/responses`、`/v1/chat/completions`、`/v1/completions`，以及对应的 API-key 非流式路径）；一旦已经开始向下游输出，就保留原始失败，不做半途续流。只要 proxy 已启用，`codexm list` 和 dashboard 里当前配置的真实 upstream 行都会带上 `@` 标记，即使还没有新的 proxy 请求发出。最近一次真实 proxy 命中仍会单独显示为 `Proxy last upstream: ...` 和 dashboard 详情区里的 `Last upstream: ...`。这个 daemon 同时提供 OpenAI-compatible `/v1` 接口，覆盖 Responses、Chat Completions、旧版 Completions、Models，以及有 API-key 上游时的 Embeddings。

对 `codexm` 托管的 proxy 入口，`codexm proxy enable` 现在会改写 `chatgpt_base_url` 和 `openai_base_url`，但不再改 live provider 身份；`codexm run --proxy` 仍然会在隔离 overlay 里使用自定义 provider。这样 live proxy CLI/Desktop 能继续共用历史，而隔离 proxy run 仍然可以把实时 Responses websocket turn 和 REST 请求都强制导向本地 proxy。这个保证仍然只覆盖 `codexm` 托管入口；如果你绕过 `codexm` 直接裸跑 `codex` 或 Desktop，则不保证一定经过本地 proxy。

`codexm daemon start`、`codexm daemon restart`、`codexm autoswitch enable` 和 `codexm proxy enable` 操作的是同一个共享后台 daemon。用 `codexm daemon status` 查看当前启用能力。`codexm daemon stop` 现在只停止进程，但会保留最近一次 daemon feature 状态，所以后续再执行 `codexm daemon start` 或 `codexm daemon restart` 时，会恢复之前的 `autoswitch` 和 `proxy` 开关。`codexm proxy enable [--force]` 和 `codexm proxy disable [--force]` 现在会复用和 `switch` 一样的 managed Desktop reload 路径；如果当前没有 codexm 托管的 Desktop，会只给出 `--force` 无意义的 warning。`codexm switch <name>` 不会再隐式关闭 proxy：它会更新保存的 direct 当前账号，而这个账号会在 proxy 保持启用时立刻成为当前上游，直到后续某次 autoswitch 因耗尽信号再把它切走。只有在你明确想恢复 direct auth/config 并清掉 proxy 配置时，才使用 `codexm proxy disable`。daemon 会把可读的 `daemon.log`、结构化的每日事件日志，以及每日 proxy 请求元信息日志写到 `~/.codex-team/logs/`。

当默认 `14555` 端口被占用时，可以设置 `CODEXM_PROXY_PORT=<port>` 统一覆盖共享 proxy/daemon 的监听端口。`codexm daemon start`、`codexm autoswitch enable`、`codexm launch`、`codexm proxy enable` 和 `codexm run --proxy` 都会读取这个环境变量；如果显式传了 `--port`，仍然以命令行参数为准。

## 输出示例

下面是一个脱敏后的 `codexm list` 示例：

```text
$ codexm list
Current managed account: plus-main
Daemon: off | Proxy: off | Autoswitch: off
Accounts: 2/3 usable | blocked: 1W 1, 5H 0 | plus x2, team x1
Available: bottleneck 0.84 | 5H->1W 0.84 | 1W 1.65 (plus 1W)
Usage 7d: in 182k/$0.42 | out 96k/$0.71 | total 278k/$1.13

   NAME         IDENTITY  PLAN  SCORE   ETA     USED      NEXT RESET
   -----------  --------  ----  -----  -----   5H   1W   ----------
*  plus-main    ac1..123  plus    72%   2.1h   58%  41%  04-14 18:30
   team-backup  ac9..987  team    64%   1.7h   61%  39%  04-14 19:10
   plus-old     ac4..456  plus     0%      -   43% 100%  04-16 09:00
```

如果你想判断“接下来该切到哪个账号”，优先看这个命令。

## 常用命令

<!-- GENERATED:CORE_COMMANDS:START -->
### 账号管理

- `codexm add <name>`: 新增一个托管账号快照
- `codexm save <name>`: 把当前生效的 auth 保存成命名快照
- `codexm update`: 刷新当前托管账号对应的已保存快照
- `codexm rename <old> <new>`: 重命名已保存快照
- `codexm protect <name>`: 将已保存快照排除出自动切换候选
- `codexm unprotect <name>`: 恢复已保存快照进入自动切换候选
- `codexm remove <name> --yes`: 删除已保存快照
- `codexm export [name] [--output <file>]`: 把当前 auth 或已保存快照导出成分享 bundle
- `codexm import <file> --name <local-name>`: 把分享 bundle 导入成命名托管账号
- `codexm inspect <file>`: 导入前预览 bundle 元数据

### 查看状态与 quota

- `codexm`: 在交互式终端里直接打开账号面板
- `codexm current [--refresh]`: 查看当前账号；可选刷新 quota
- `codexm doctor`: 诊断本地 auth、runtime 探测和托管 Desktop 一致性
- `codexm list [--refresh] [--usage-window <today|7d|30d|all-time>] [--verbose]`: 查看所有保存账号，并附带一行本地 usage 摘要
- `codexm list --json`: 输出机器可读 JSON；包含 proxy 当前上游信息，以及有数据时最近一次上游命中信息
- `codexm list --debug`: 输出 quota 归一化和观测比例相关诊断信息
- `codexm proxy status`: 查看本地 proxy daemon 和 synthetic auth 状态
- `codexm daemon status`: 查看共享后台 daemon、已启用能力和日志路径
- `codexm autoswitch status`: 查看 daemon 驱动的自动切号是否已启用
- `codexm tui [query]`: 显式打开账号面板，可选带初始筛选词；在 proxy 行上按 Enter 会切换 proxy 开关
- `codexm usage [--window <today|7d|30d|all-time>] [--daily] [--json]`: 从本地 session 日志汇总 token usage 和 estimated cost

### 切换与启动

- `codexm switch <name>`: 切换到指定保存的 direct 账号；若 proxy 已启用，这会立刻成为 proxy 的当前上游，直到后续 autoswitch 事件再把它切走
- `codexm switch --auto --dry-run`: 预览自动切号会选中的账号
- `codexm launch [name] [--auto]`: 在 macOS 上启动 Codex Desktop，并确保共享 daemon 已启动

### Watch 与自动重启

- `codexm watch`: 监听 quota 变化，并在耗尽时自动切号
- `codexm autoswitch enable`: 启用 daemon 驱动的自动切号；proxy 在用户可见输出开始前遇到耗尽时也会内部重放一次
- `codexm autoswitch disable`: 关闭自动切号，并保留基础 daemon 常驻
- `codexm daemon start`: 启动共享后台 daemon，但不额外启用附加能力
- `codexm daemon stop`: 停止共享后台 daemon，并保留最近一次 daemon 功能开关状态
- `codexm run [--account <name>] [-- ...codexArgs]`: 以全局 auth 跟随重启模式运行 codex，或用托管账号快照做一次性隔离运行
- `codexm run --proxy [-- ...codexArgs]`: 用隔离 CODEX_HOME 通过本地 proxy 运行 codex
- `codexm proxy enable`: 启用由本地 proxy 提供的全局 synthetic ChatGPT auth；在 proxy 耗尽且用户可见输出尚未开始时会自动重放一次
- `codexm proxy disable`: 恢复上一次 direct auth/config 备份并停止 proxy daemon
- `codexm overlay create <name>`: 为其他工具创建隔离的 CODEX_HOME overlay
<!-- GENERATED:CORE_COMMANDS:END -->

完整命令参考请使用 `codexm --help`。分享 bundle 是明文 auth 快照，只适合发给完全信任的接收方。

在交互式终端里，直接运行 `codexm` 就会进入账号面板。除了 `Enter` / `a` / `f` / `p` / `o` / `O` / `d` / `Shift+D`，还可以用 `e` / `E` 导出选中账号或当前 auth，用 `i` 导入 bundle，用 `x` 删除选中账号，用 `u` 撤销最近一次 import/export/delete。`a` 用来切换 daemon 驱动的 autoswitch，`p` 用来切换选中账号是否允许被自动切号逻辑选中；如果当前就在用这个账号，后续自动切走它仍然是允许的。`Esc` 用来后退或取消当前流程，`q` 用来从主面板退出。dashboard 列表里的 `Next reset` 现在和 `codexm list` 使用同一套格式，最后 1 小时内会显示带颜色的分钟倒计时，详情区会固定展示 `5H reset` 和 `1W reset`。如果刷新 quota 失败，`codexm list` 和 dashboard 会回退到该账号最近一次成功的 quota 快照，最多保留 7 天，并把该行标成 `[stale]`。synthetic `proxy` 行即使在 proxy 关闭时也会保留；proxy 已启用时，`@` 标记表示当前配置的真实 upstream，`Last upstream: ...` 只会在最近一次真实 proxy 命中已知时出现。`[autoswitch:on|off]` 状态位仍然只表示 daemon/watch 的开关，不表示 proxy 内部上游选路。如果托管 Desktop 切号需要等当前 thread 跑完，账号面板底部状态行现在会显示这段等待进度，而不是一直停在泛化的 busy 文案上。如果当前没有其他存活的 watch owner，且当前 Desktop 会话是 `codexm` 托管的，账号面板会在前台挂一个 watch；这条前台 watch 会跟随当前 autoswitch 开关，并在退出时停止。

## 什么时候该用哪个命令？

- 如果你想判断“接下来该用哪个账号”，优先看 `codexm list`
- 如果你想看本地 token 量和 estimated cost，优先看 `codexm usage`
- 如果你想为托管 Desktop 或 proxy 开启后台自动切号，使用 `codexm autoswitch enable`
- 如果你想只启动共享后台 daemon，而不启用 autoswitch 或 proxy，使用 `codexm daemon start`
- 如果你想在前台监控 quota 并在耗尽时响应，使用 `codexm watch`
- 如果你在 CLI 场景里希望运行中的 `codex` 跟随切号自动重启，使用 `codexm run`
- 如果你希望 Codex 或其他工具只看到一个稳定的本地 API/auth，而真实上游账号由 `codexm` 内部轮换，使用 `codexm proxy enable`
- 如果你想临时使用 proxy，但不希望把 session 或 auth/config 写进真实 `CODEX_HOME`，使用 `codexm run --proxy`
- 如果共享 proxy/daemon 需要避开默认 `14555`，设置 `CODEXM_PROXY_PORT`；对 `codexm proxy enable` 来说，显式 `--port` 仍然优先
- 脚本场景使用 `--json`，排查问题使用 `--debug`

对于 ChatGPT 登录快照，如果本地 token 能区分同一 ChatGPT 账号或 workspace 下的不同用户，`codex-team` 也可以把它们保存成不同的托管条目。

## Shell Completion

<!-- GENERATED:SHELL_COMPLETION:START -->
按 shell 的标准方式生成并安装补全脚本：

```bash
mkdir -p ~/.zsh/completions
codexm completion zsh > ~/.zsh/completions/_codexm

mkdir -p ~/.local/share/bash-completion/completions
codexm completion bash > ~/.local/share/bash-completion/completions/codexm
```

生成的脚本会补全命令、已知二级命令、当前输入以 `-` 开头时的 flag，并通过 `codexm completion --accounts` 动态补全已保存账号名。
<!-- GENERATED:SHELL_COMPLETION:END -->

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

真实自测可以在需要时调用线上 ChatGPT/OpenAI 服务，但必须使用临时 `HOME`、隔离 `CODEX_HOME` 或 codexm overlay，避免写入本地真实 threads、sessions、auth/config、socket，也不能干扰正在运行的 CLI/TUI/Desktop 实例。

## License

MIT
