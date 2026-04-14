# 如何在一台机器上管理多个 Codex 账号

这篇指南介绍如何用 `codexm` 在一台机器上管理多个 Codex 账号，而不是手动来回复制 `~/.codex/auth.json`。

English version: [How to manage multiple Codex accounts on one machine](../manage-multiple-codex-accounts.md)

## 问题是什么

如果你同时使用多个 Codex 账号，默认流程通常比较别扭：

- 同一时间只能有一个生效的 `~/.codex/auth.json`
- 切号往往意味着手动拷文件或者重新登录
- 很难记住每份本地 auth 到底对应哪个账号

`codexm` 的思路是把这些 auth 保存成命名快照，再把切号变成稳定的 CLI 操作。

## 适合什么场景

如果你符合这些情况，就适合这套流程：

- 你同时使用个人、团队或备用 Codex 账号
- 你会在 Codex Desktop 和 Codex CLI 之间切换
- 你希望用 `plus-main`、`team-backup` 这种名字管理账号，而不是盯着原始 auth 文件

## 快速开始

先保存多个账号：

```bash
codexm add plus-main
codexm add team-backup
```

如果你已经登录好了，只想把当前 auth 存起来：

```bash
codexm save plus-main
```

查看当前有哪些已保存账号，以及当前生效的是谁：

```bash
codexm list
```

切换到另一个已保存账号：

```bash
codexm switch team-backup
```

## 你会得到什么

走完这套流程之后：

- 每个账号都有稳定名字
- `codexm list` 可以集中查看所有已保存账号
- `codexm switch <name>` 会更新当前生效的 `~/.codex/auth.json`

也就是说，“管理多个 Codex 账号”从手动文件操作变成了可重复的命令行流程。

## 常见误区

- 账号名起得太随意，比如 `a1`、`a2`，后面很难维护
- 已经手动切过 auth，但忘了再用 `codexm save` 存成快照
- 把 `codexm list` 只当成状态命令，而不是“下一步该切哪个账号”的决策面板

## 相关指南

- [如何监控 Codex quota 并自动切号](./monitor-codex-quota-and-auto-switch.md)
- [如何把 codexm 用在 Codex Desktop](./use-codexm-with-codex-desktop.md)
- [如何把 codexm 用在 Codex CLI](./use-codexm-with-codex-cli.md)
