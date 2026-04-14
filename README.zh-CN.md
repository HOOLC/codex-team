# codex-team

[English](./README.md) | [简体中文](./README.zh-CN.md)

`codex-team` 提供 `codexm` 命令，用来在一台机器上管理多个 Codex ChatGPT 登录快照。

如果你经常在多个 Codex 账号之间切换，它可以帮你更简单地：

- 保存多个命名账号快照
- 切换当前生效的 `~/.codex/auth.json`
- 查看多个账号的 quota 使用情况
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

## 快速开始

### macOS + Codex Desktop

```bash
codexm add plus1
codexm add team1
codexm launch --watch
```

这会新增几个命名快照、启动 Codex Desktop，并在后台保持 watcher 运行。

### Linux / WSL + Codex CLI

```bash
codexm add plus1
codexm add team1
codexm watch
```

在另一个终端里通过 wrapper 启动 Codex：

```bash
codexm run -- --model o3
```

`codexm watch` 会持续监控 quota，并在耗尽时自动切号。`codexm run` 会包装 `codex` CLI，在 `~/.codex/auth.json` 变化后自动重启，这样长时间运行的 CLI 会话就能自动跟随切号。

## 输出示例

下面是一个脱敏后的 `codexm list` 示例：

```text
$ codexm list
Current managed account: plus-main
Accounts: 2/3 usable | blocked: 1W 1, 5H 0 | plus x2, team x1
Total: bottleneck 0.84 | 5H->1W 0.84 | 1W 1.65 (plus 1W)

  NAME         IDENTITY   PLAN  SCORE  ETA   5H USED  1W USED  NEXT RESET
* plus-main    acct...123 plus  72%    2.1h  58%      41%      04-14 18:30
  team-backup  acct...987 team  64%    1.7h  61%      39%      04-14 19:10
  plus-old     acct...456 plus  0%     -     43%      100%     04-16 09:00
```

如果你想判断“接下来该切到哪个账号”，优先看这个命令。

## 常用命令

<!-- GENERATED:CORE_COMMANDS:START -->
### 账号管理

- `codexm add <name>`: 新增一个托管账号快照
- `codexm save <name>`: 把当前生效的 auth 保存成命名快照
- `codexm rename <old> <new>`: 重命名已保存快照
- `codexm remove <name> --yes`: 删除已保存快照

### 查看状态与 quota

- `codexm current [--refresh]`: 查看当前账号；可选刷新 quota
- `codexm list [--verbose]`: 查看所有保存账号、quota、score、ETA 和 reset 时间
- `codexm list --json`: 输出机器可读 JSON
- `codexm list --debug`: 输出 quota 归一化和观测比例相关诊断信息

### 切换与启动

- `codexm switch <name>`: 切换到指定保存账号
- `codexm switch --auto --dry-run`: 预览自动切号会选中的账号
- `codexm launch [name] [--auto] [--watch]`: 在 macOS 上启动 Codex Desktop

### Watch 与自动重启

- `codexm watch`: 监听 quota 变化，并在耗尽时自动切号
- `codexm watch --detach`: 后台运行 watcher
- `codexm watch --status`: 查看后台 watcher 状态
- `codexm watch --stop`: 停止后台 watcher
- `codexm run [-- ...codexArgs]`: 在 auth 变化后自动重启 codex CLI
<!-- GENERATED:CORE_COMMANDS:END -->

完整命令参考请使用 `codexm --help`。

## 什么时候该用哪个命令？

- 如果你想判断“接下来该用哪个账号”，优先看 `codexm list`
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
