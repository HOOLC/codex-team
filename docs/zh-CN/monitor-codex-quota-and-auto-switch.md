# 如何监控 Codex quota 并自动切号

这篇指南介绍如何用 `codexm` 查看 Codex quota、判断哪个账号还能用，以及在当前账号耗尽时自动切号。

English version: [How to monitor Codex quota and auto-switch accounts](../monitor-codex-quota-and-auto-switch.md)

## 问题是什么

对多账号用户来说，难点不只是“把账号存起来”，而是：

- 现在到底哪个账号还有 quota
- 当前账号大概还能撑多久
- 下一个最合适切过去的账号是谁

`codexm` 正好提供了围绕 quota 的一套工作流。

## 先从 `codexm list` 开始

最核心的命令是：

```bash
codexm list
```

这个视图主要回答：

- 当前账号是谁
- 哪些账号现在还能用
- 5 小时和 1 周窗口分别用了多少
- 下一个最适合使用的账号是谁

如果你只想看当前账号：

```bash
codexm current --refresh
```

## 账号耗尽后自动切号

如果你希望持续监控 quota，并在耗尽时自动切换账号：

```bash
codexm watch
```

在 macOS 上，也可以配合受管 Desktop 启动：

```bash
codexm launch --watch
```

如果你只想先预览自动切号会选谁：

```bash
codexm switch --auto --dry-run
```

## 你会得到什么

用了这套流程之后：

- `codexm list` 就是你的 quota 决策面板
- `codexm watch` 就是你的自动化循环
- `codexm switch --auto --dry-run` 就是切号预演

如果你的真实需求是“看 Codex quota”或者“quota 用尽后自动切号”，这就是最直接的入口。

## 常见误区

- 不看 `list`，直接盲切账号
- 只盯一个 quota 窗口，而不看整体 score 和 ETA
- 把 `watch` 当成一次性检查，而不是长期运行的自动化流程

## 相关指南

- [如何在一台机器上管理多个 Codex 账号](./manage-multiple-codex-accounts.md)
- [如何把 codexm 用在 Codex Desktop](./use-codexm-with-codex-desktop.md)
- [如何把 codexm 用在 Codex CLI](./use-codexm-with-codex-cli.md)
