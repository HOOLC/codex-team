# 如何把 codexm 用在 Codex Desktop

这篇指南介绍 macOS 下的 Codex Desktop 工作流：如何通过 `codexm` 启动 Desktop、保持受管会话，以及把 Desktop 与 quota watch 组合起来。

English version: [How to use codexm with Codex Desktop](../use-codexm-with-codex-desktop.md)

## 什么场景适合

如果你符合这些条件，就适合这条路径：

- 你在 macOS 上使用 Codex Desktop
- 你希望账号切换能和 Desktop 会话协同工作
- 你希望通过 `codexm` 用指定账号启动 Desktop

## 通过 codexm 启动 Desktop

用当前 auth 启动 Codex Desktop：

```bash
codexm launch
```

用指定已保存账号启动：

```bash
codexm launch plus-main
```

启动 Desktop 的同时开启后台 quota watch：

```bash
codexm launch --watch
```

## 为什么这样更稳

对于 Desktop 用户来说，`codexm launch` 比“先手动打开 Desktop，再想办法对齐 auth 状态”更清晰。

如果你的问题更接近这些搜索意图，这条路径最合适：

- 怎么在 Codex Desktop 里使用多个账号
- 怎么用指定账号启动 Codex Desktop
- 怎么让 Desktop 切号和 quota 自动化更一致

## 常见误区

- 手动打开 Desktop，却期望它表现得和 `codexm` 受管启动一样
- 没搞清当前 Desktop 会话是不是受管状态，就直接用 `switch`
- 在 Codex Desktop 内部终端执行 `codexm launch`，而不是外部终端

## 相关指南

- [如何在一台机器上管理多个 Codex 账号](./manage-multiple-codex-accounts.md)
- [如何监控 Codex quota 并自动切号](./monitor-codex-quota-and-auto-switch.md)
- [如何把 codexm 用在 Codex CLI](./use-codexm-with-codex-cli.md)
