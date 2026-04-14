# 如何把 codexm 用在 Codex CLI

这篇指南介绍 Linux、WSL 和终端优先场景下的 Codex CLI 工作流：如何让运行中的 CLI 会话跟随账号切换自动重启。

English version: [How to use codexm with Codex CLI](../use-codexm-with-codex-cli.md)

## 什么场景适合

如果你主要在终端里使用 Codex，这条路径更适合：

- 你主要通过命令行使用 Codex
- 你希望长时间运行的 Codex CLI 会话能跟随账号切换
- 你在 Linux 或 WSL 上使用，不依赖 Desktop 启动链路

## 推荐工作流

先保存几个账号：

```bash
codexm add plus-main
codexm add team-backup
```

启动 quota 监控：

```bash
codexm watch
```

在另一个终端里，通过 wrapper 运行 Codex：

```bash
codexm run -- --model o3
```

## 为什么这样更合适

`codexm run` 会包装 `codex` CLI，并在当前 auth 变化时自动重启它。因此它很适合：

- 长时间运行的 Codex CLI 会话
- 配合 `codexm watch` 的自动切号链路
- Linux 和 WSL 这类更偏 CLI 的环境

## 常见误区

- 直接启动 `codex`，而不是通过 `codexm run`
- 以为只跑 `watch` 就会自动重启你当前运行的 CLI
- 忘了把包装后的 CLI 放到另一个终端里运行

## 相关指南

- [如何在一台机器上管理多个 Codex 账号](./manage-multiple-codex-accounts.md)
- [如何监控 Codex quota 并自动切号](./monitor-codex-quota-and-auto-switch.md)
- [如何把 codexm 用在 Codex Desktop](./use-codexm-with-codex-desktop.md)
