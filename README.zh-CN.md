# codex-team

[English](./README.md) | [简体中文](./README.zh-CN.md)

`codex-team` 提供 `codexm` 命令，用来在一台机器上管理多个 Codex ChatGPT 登录快照。

它适合经常在多个 Codex 账号之间切换的用户，主要解决这些问题：

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

典型流程：

- `codexm add <name>` 打开 ChatGPT 登录流程并保存一个命名快照
- `codexm launch --watch` 启动 Codex Desktop，同时保持后台 watcher 运行
- 当当前账号耗尽时，watcher 可以自动切换到最合适的已保存账号

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

典型流程：

- `codexm watch` 持续监控 quota，并在耗尽时自动切号
- `codexm run` 包装 `codex` CLI，在 `~/.codex/auth.json` 变化后自动重启
- 这样长时间运行的 CLI 会话可以自动跟随切号

## 常用命令

### 账号管理

- `codexm add <name>`：新增一个托管账号快照
- `codexm save <name>`：把当前生效的 auth 保存成命名快照
- `codexm rename <old> <new>`：重命名已保存快照
- `codexm remove <name> --yes`：删除已保存快照

### 查看状态与 quota

- `codexm current [--refresh]`：查看当前账号；可选刷新 quota
- `codexm list [--verbose]`：查看所有保存账号、quota、score、ETA 和 reset 时间
- `codexm list --json`：输出机器可读 JSON
- `codexm list --debug`：输出 quota 归一化和观测比例相关诊断信息

### 切换与启动

- `codexm switch <name>`：切换到指定保存账号
- `codexm switch --auto --dry-run`：预览自动切号会选中的账号
- `codexm launch [name] [--auto] [--watch]`：在 macOS 上启动 Codex Desktop

### Watch 与自动重启

- `codexm watch`：监听 quota 变化，并在耗尽时自动切号
- `codexm watch --detach`：后台运行 watcher
- `codexm watch --status`：查看后台 watcher 状态
- `codexm watch --stop`：停止后台 watcher
- `codexm run [-- ...codexArgs]`：在 auth 变化后自动重启 `codex` CLI

完整命令参考请使用 `codexm --help`。

## 使用建议

- 如果你想判断“接下来该用哪个账号”，优先看 `codexm list`
- 如果你想自动切号，使用 `codexm watch`
- 如果你在 CLI 场景里希望运行中的 `codex` 跟随切号自动重启，使用 `codexm run`
- 脚本场景使用 `--json`，排查问题使用 `--debug`

对于 ChatGPT 登录快照，如果本地 token 能区分同一 ChatGPT 账号或 workspace 下的不同用户，`codex-team` 也可以把它们保存成不同的托管条目。

## Shell Completion

按 shell 的标准方式生成并安装补全脚本：

```bash
mkdir -p ~/.zsh/completions
codexm completion zsh > ~/.zsh/completions/_codexm

mkdir -p ~/.local/share/bash-completion/completions
codexm completion bash > ~/.local/share/bash-completion/completions/codexm
```

生成的脚本会通过 `codexm completion --accounts` 动态补全已保存账号名。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
