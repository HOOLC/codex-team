# codex-team

[English](./README.md) | [简体中文](./README.zh-CN.md)

`codex-team` 提供 `codexm` 命令，用来在一台机器上管理多个 Codex ChatGPT 登录快照。

如果你经常在多个 Codex 账号之间切换，它可以帮你更简单地：

- 保存多个命名账号快照
- 切换当前生效的 `~/.codex/auth.json`
- 查看多个账号的 quota 使用情况
- 导出和导入完全信任前提下的分享 bundle，而不需要重新登录
- 在当前账号耗尽时自动切号并重启运行中的 Codex

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
- `f`：在当前账号上 reload，或强制切号
- `p`：切换“是否允许自动切号选中该账号”的保护状态
- `o`：在当前终端运行 `codex`，退出后回到 dashboard
- `O`：用隔离的托管快照运行 `codex`，退出后回到 dashboard
- `d`：打开或聚焦 Codex Desktop，但不离开 dashboard
- `Shift+D`：用选中账号重新拉起 Codex Desktop；如果当前已有非 `codexm` 托管的 Desktop，会先确认再强制关闭重启

如果 quota refresh 失败，dashboard 会保留上一份成功的 quota 视图，并通过 warning/failure 提示异常，而不是把列表、汇总和详情面板一起打乱成退化状态。

### 3. 让它持续自动工作

macOS + Codex Desktop：

```bash
codexm launch --watch
```

Linux / WSL + Codex CLI：

```bash
codexm watch
```

在另一个终端里通过 wrapper 启动 Codex：

```bash
codexm run -- --model o3
```

`codexm watch` 会持续监控 quota，并在耗尽时自动切号。`codexm run` 会包装 `codex` CLI，能够在 `~/.codex/auth.json` 被重复原子替换后继续自动重启，并在账号切换触发重启后自动恢复当前交互会话。如果你手动结束 `codexm run` 且当前 session 可恢复，它会打印可直接使用的恢复命令。`codexm current --refresh` 会优先读取托管 Desktop runtime quota，其次尝试 ChatGPT usage API；如果 API 临时不可用，会回退到最近的 cached quota，并标记为 `stale`。

## 输出示例

下面是一个脱敏后的 `codexm list` 示例：

```text
$ codexm list
Current managed account: plus-main
Accounts: 2/3 usable | blocked: 1W 1, 5H 0 | plus x2, team x1
Available: bottleneck 0.84 | 5H->1W 0.84 | 1W 1.65 (plus 1W)
Usage 7d: in 182k/$0.42 | out 96k/$0.71 | total 278k/$1.13

  NAME         IDENTITY  PLAN  SCORE   ETA     USED      NEXT RESET
  -----------  --------  ----  -----  -----   5H   1W   ----------
* plus-main    ac1..123  plus    72%   2.1h   58%  41%  04-14 18:30
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
- `codexm list [--usage-window <today|7d|30d|all-time>] [--verbose]`: 查看所有保存账号，并附带一行本地 usage 摘要
- `codexm list --json`: 输出机器可读 JSON
- `codexm list --debug`: 输出 quota 归一化和观测比例相关诊断信息
- `codexm tui [query]`: 显式打开账号面板，可选带初始筛选词
- `codexm usage [--window <today|7d|30d|all-time>] [--daily] [--json]`: 从本地 session 日志汇总 token usage 和 estimated cost

### 切换与启动

- `codexm switch <name>`: 切换到指定保存账号
- `codexm switch --auto --dry-run`: 预览自动切号会选中的账号
- `codexm launch [name] [--auto] [--watch]`: 在 macOS 上启动 Codex Desktop

### Watch 与自动重启

- `codexm watch`: 监听 quota 变化，并在耗尽时自动切号
- `codexm watch --detach`: 后台运行 watcher
- `codexm watch --status`: 查看后台 watcher 状态
- `codexm watch --stop`: 停止后台 watcher
- `codexm run [--account <name>] [-- ...codexArgs]`: 以全局 auth 跟随重启模式运行 codex，或用托管账号快照做一次性隔离运行
- `codexm overlay create <name>`: 为其他工具创建隔离的 CODEX_HOME overlay
<!-- GENERATED:CORE_COMMANDS:END -->

完整命令参考请使用 `codexm --help`。分享 bundle 是明文 auth 快照，只适合发给完全信任的接收方。

在交互式终端里，直接运行 `codexm` 就会进入账号面板。除了 `Enter` / `f` / `p` / `o` / `O` / `d` / `Shift+D`，还可以用 `e` / `E` 导出选中账号或当前 auth，用 `i` 导入 bundle，用 `x` 删除选中账号，用 `u` 撤销最近一次 import/export/delete。`p` 用来切换选中账号是否允许被自动切号逻辑选中；如果当前就在用这个账号，后续自动切走它仍然是允许的。`Esc` 用来后退或取消当前流程，`q` 用来从主面板退出。如果托管 Desktop 切号需要等当前 thread 跑完，账号面板底部状态行现在会显示这段等待进度，而不是一直停在泛化的 busy 文案上。如果当前没有 detached `codexm watch`，且当前 Desktop 会话是 `codexm` 托管的，账号面板会在前台挂一个 watch，同时避免和其他存活的 watch 重复；退出时则把这条 watch 交接给 detached watcher。

## 什么时候该用哪个命令？

- 如果你想判断“接下来该用哪个账号”，优先看 `codexm list`
- 如果你想看本地 token 量和 estimated cost，优先看 `codexm usage`
- 如果你想自动切号，使用 `codexm watch`
- 如果你在 CLI 场景里希望运行中的 `codex` 跟随切号自动重启，使用 `codexm run`
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

生成的脚本会通过 `codexm completion --accounts` 动态补全已保存账号名。
<!-- GENERATED:SHELL_COMPLETION:END -->

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
